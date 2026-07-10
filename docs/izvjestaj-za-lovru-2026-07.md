# Izvještaj backend strane — srpanjski incident + odgovori na [CONFIRM] stavke

Za: Lovre
Od: backend (Ivan)
Datum: 10.7.2026.

## 1. Ispravak dijagnoze incidenta (Biblija, Sekcija 2.7 i 0)

Biblija tvrdi da je live "Fable-regeneracija koja referencira nepostojeći tool" i da je
hitna akcija "redeploy CURRENT.md". Forenzika iz produkcijske baze pokazuje drugačije:

- **Deployani prompt JE tvoj `Fillchair_Master_Prompt_CURRENT.md`** — nije regeneracija.
  Jedine razlike su tri dokumentirane tehničke adaptacije (točka 4 dolje).
- **`get_started_link` ne postoji nigdje** u deployanom promptu ni u SOT-u (provjereno
  grep-om). GPT-4o ga je izmislio u runtimeu. Redeploy istog filea ne mijenja ništa.
- Booking turn (6.7. 19:02 UTC): native `mark_link_sent()` **JE okinuo** (event postoji u
  bazi) — model je istovremeno pozvao pravi tool I ispisao `[get_started_link()]` kao tekst.
- Slur turn (6.7. 19:04 UTC): native `escalate_to_owner` **NIJE okinuo** (nema escalation
  reda, nema eventa, bot nije pauziran). Model je cijeli poziv ispisao kao tekst.

**Pravi uzrok:** GPT-4o povremeno imitira bracket notaciju iz EXAMPLES sekcije
(`[mark_link_sent()]` ispod svakog primjera) i ispiše je kao dio odgovora, umjesto (ili uz)
native function call. Isti failure mode dogodio se i u lipnju (obećan handoff, prazan
toolCalls, bez bracketa) — dakle kronična nestabilnost tool-pozivanja, ne v3 regresija.
Tvoje trvdnje o "voice degradation": poruka "Hey there! What's up? 😊" od 4.7. išla je kroz
STARI prompt (v3 je deployan 5.7.) — nikakav template/greeting path ne postoji u backendu,
sve ide kroz master prompt.

## 2. Što je backend implementirao (10.7.)

Točno ono što Biblija traži u Sekcijama 10 i 12, plus oporavak namjere:

1. **Bracket-strip s oporavkom namjere**: svaki `[tool(...)]` pattern u LLM tekstu se
   parsira i briše prije slanja. Ako je `escalate_to_owner` procurio kao tekst a native
   nije okinuo → backend **prisilno eskalira s parsiranim reasonom** (klijentu je obećano).
   Procureni `mark_link_sent` → event se svejedno zapiše (dedup ne puca). Procureni
   `set_state_flag` → state se merga (uz postojeću key-whitelistu). Nepoznata imena
   (npr. `get_started_link`) → samo strip + warn log. `sanitize_mods` dobiva
   `tool_call_text_stripped` pa su ovi slučajevi queryable.
2. **Orchestrator warn-loga native pozive nepoznatih toolova** (ne izvršava ih).
3. **Prošireni handoff-promise detektor** (backend safety net od prije): sad hvata i
   "I'm letting Renata handle this one" (točan produkcijski promašaj) i
   "Imma let [owner] take this one" (tvoj primjer iz Sekcije 14!).
4. **Prompt hardening** — u Sekciju 12 (TOOL USAGE) dodan ovaj paragraf, koji po
   layer-sync pravilu (Sekcija 13.2) MORAŠ backportati u Layer 1 generator i CURRENT.md:

   > The bracketed notation you see in this prompt's examples, like [mark_link_sent()] or
   > [escalate_to_owner(...)], is documentation shorthand for INVISIBLE native function
   > calls. It is never part of the reply. Never write that notation, any bracketed
   > function name, or any tool syntax in your reply text. Your text contains only the
   > words the client reads. Fire tools exclusively through the function-calling
   > interface, and only the three tools below exist — never invent a tool name.

## 3. Odgovori na [CONFIRM] stavke (Biblija 0.5)

- **#2 State linije: SHIPPED (5.7.).** "Hours since last client message" ide uvijek kad
  postoji prethodna poruka (računa se od POČETKA batched bursta, pa 3 brze poruke nakon
  2 dana tišine prijave ~48, ne 0). "Current date and time (salon local)" ide kad salon
  ima postavljen `timezone` (IANA, novo config polje; Lumen = Europe/Zagreb). Bez
  timezone-a linija se izostavlja — prompt degradira sigurno, kako je dizajnirano.
- **#3 `service_menu.not_offered`: SHIPPED (5.7.).** Optional array stringova, default
  prazan kad `service_menu` postoji; stari SOT-ovi bez polja i dalje validiraju.
  Lumen test SOT ima popunjeno: nails, lashes, makeup, brows, perms, barbering.
- **#4 Dedup N: NIJE broj poruka — 24-satni vremenski prozor.** Promijenjeno 5.7. na
  zahtjev vlasnika (razgovor stariji od 24h treba ponovno dobiti link). State linija i
  sanitizer čitaju ISTO config polje (`booking_link_dedup_window_hours`, default 24) pa
  divergencija nije moguća. Ažuriraj kontrakt 5.3/5.6 i glosar ("Dedup window (N)").
- **#5 Default handoff window: 4 sata** (`handoff_window_hours`, per-salon config).
- **#6 Točan format state bloka kako ga backend printa:**

  ```
  # Conversation state
  - Booking link sent recently (within last 24h): false
  - Total inbound messages this conversation: 5
  - State flags JSON: {"client_is_hesitant":true,"last_quoted_service":"Full Balayage"}
  - Current date and time (salon local): Friday, July 10, 2026, 3:45 PM
  - Hours since last client message: 26
  ```

  Zadnje dvije linije su opcionalne (vidi #2).

## 4. Odstupanja deployanog prompta od tvog CURRENT.md (backportati u generator!)

1. **Emoji encoding**: tvoj file je stigao s pokvarenim bajtovima (`ð¤` umjesto 🤍) —
   popravljeno pri deployu. Provjeri encoding pri sljedećem exportu.
2. **Label dedup linije**: "Booking link sent in last N messages" → **"Booking link sent
   recently"** (Sekcija 2 naslov + Sekcija 7 referenca), usklađeno s time-based state
   linijom (#4 gore).
3. **Anti-dangling-colon pravilo** (Sekcija 2): kad je link nedavno poslan, model ne smije
   pisati "phrase: [URL]" konstrukciju jer sanitizer briše URL i ostane viseći dvotočak
   (produkcijski bug iz lipnja). Dodano uz "sent recently" pravilo.
4. **Anti-leak paragraf** u Sekciji 12 (točka 2.4 gore).

Bez backporta ovih izmjena, sljedeća regeneracija iz Layer 1 tiho ih briše — točno
lipanjski drift scenarij koji tvoja Sekcija 13 zabranjuje.

## 5. Bonus nalaz za GHL stranu

Klijentov text bubble **"Do you do this type of hair?"** (poslan uz shareani IG post,
6.7. ~18:52 UTC) **nikad nije stigao u backend** — u bazi postoji samo image event bez
teksta. GHL workflow nije isporučio tekst koji prati shared post. Vrijedi provjeriti
workflow trigger/merge tagove za shared-post poruke; backend tu nema što popraviti dok
webhook ne stigne.
