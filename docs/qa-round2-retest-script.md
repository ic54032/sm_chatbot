# QA Round 2 — manual retest script

Every test below maps to a numbered finding in the Round 2 report. Run them in order: the groups are
sequenced so that the tests which pause the bot come last.

**Before you start**

1. Deploy the current `main`. Anything not deployed is not being tested.
2. Use a fresh Instagram thread if you can. If you reuse the old one, the booking-link dedup window
   (24h) and any leftover handoff will change what you see.
3. Timing: the bot waits **10 seconds** before replying. Anything slower than ~30s means something
   is wrong, not that it is thinking.

**The two rules that will otherwise waste your afternoon**

- **An escalation pauses the bot for 4 hours on that conversation.** After every test marked 🔴 you
  must remove the `escalation_active` tag in GHL before continuing, otherwise the next messages get
  silence and you will read it as a new bug.
- **Media messages never reach the model.** A video, voice note or reel is classified and escalated
  before any model call, so you cannot test wording or voice with them.

**Red flags — these exact strings mean the model produced no text and a hardcoded fallback spoke**

```
let me grab Renata for you, she'll jump in as soon as she's between clients 🤍
here you go 🤍 https://lumenhairstudio.glossgenius.com/book
the booking link I sent has all the latest openings 🤍
```

Seeing one is not automatically a failure (they are the designed backstop), but seeing the *same*
one across different situations is exactly finding 4.1 and should be reported.

---

## Group A — voice, style, link discipline

Send these as a normal conversation, one after another. No escalation expected, so no tag cleanup.

| # | Send | Expect | Finding |
|---|---|---|---|
| A1 | `hey` | A warm opener. **Not** "Hi there" / "Hey there" / "Hello there" | 4.7a |
| A2 | `what all do you offer` | Two or three categories in a sentence, then a question back. **Not** a nine-service list | 4.4 |
| A3 | `how much is a balayage` | Price range + consult framing + the booking link (first time it goes out) | 9 |
| A4 | `and how long does it take` | Answers the duration and **refers back** to the link ("link's right above..."). **The full URL must NOT be pasted again** | link over-send |
| A5 | `what about a wolf cut` | Answers. Wording must not repeat sentences from A2–A4 | 4.7a |
| A6 | `are you open tomorrow?` | Hours from the knowledge base. No invented "we're open now" | 3 |

**Check across every reply in this group**

- Every sentence starts **lowercase** (only names, prices and "I" capitalised). "Balayage ranges..."
  or "Could you let me know..." is a failure. → 4.8
- No word-gluing hyphen like `availability-just`. → 4.7b
- One bubble per turn. *(Known: splitting at 40 words is still enabled pending a decision — two
  bubbles on a long reply is expected for now, not a new bug.)* → 4.6
- No machinery talk: no "noting", "flagging", "I'll make a note", "escalating". → 1.9

---

## Group B — fabrication guards

Still no escalation expected.

| # | Send | Expect | Finding |
|---|---|---|---|
| B1 | `is Petra still working there?` | Names the current team (renata, tash, mia) and moves on. **Must NOT say she left, used to work there, or is no longer there** | 4.5 |
| B2 | `how do i pay?` | Only what the knowledge base says: a card on file is required to book. **Must NOT add "cash accepted"** | 4.5 |
| B3 | `im 15, can i get my hair coloured?` | No invented consent rule. Routes to a consult where the owner confirms | 1.6 |
| B4 | `do you do a student discount?` | No invented discount policy | 3 |
| B5 | `did you see my video?` *(plain text, do not attach anything)* | Warm redirect asking what they are going for. **Must NOT say "I didn't receive a video", "I can't watch videos", or any version of it, even after a "but"** | 4.3 |

---

## Group C — media handling 🔴

Each of these escalates. **Remove the `escalation_active` tag after every single one.**
After each, open the contact in GHL and read the `last_escalation_reason` field.

| # | Send | Expect in GHL | Finding |
|---|---|---|---|
| C1 | A photo of hair | **No escalation.** Bot names one concrete thing it sees in that photo | 1.3 |
| C2 | A video | Escalation, field reads **"Client sent a video, take a look"** | 3.1 |
| C3 | A voice note | Escalation, field reads **"Client sent a voice note, take a look"**. *If it says "video", finding 3.2 is not fixed* | 3.2 |
| C4 | A shared reel | Escalation, field reads **"Client shared a reel or disappearing photo, take a look"** | 3.1 / B7 |
| C5 | A disappearing (view-once) photo | Same as C4 | 3.1 |

**Known gap, do not report as new:** C2–C5 send the client **nothing** — the escalation is silent by
design today. The original image-handling design specified a warm line before escalating and it was
never wired. Decision pending.

**Also check on C1:** the reply must not repeat a generic line that would fit any photo.

---

## Group D — escalation quality 🔴

This group targets finding 4.1 (every escalation shipping the identical sentence) and 4.2 (the
hesitant client losing all empathy). **Remove the tag between each one**, and use a fresh thread for
D3 if you can, so the link state does not muddy it.

| # | Send | Expect | Finding |
|---|---|---|---|
| D1 | `i want a refund on my last appointment` | A **refund-shaped** warm line, then escalation. GHL field: "Refund request" | 4.1 |
| D2 | `my scalp has been really irritated since chemo, is it safe to colour?` | A **health-shaped** warm line, no medical opinion, then escalation. GHL field: "Health question, needs you" | 4.1 |
| D3 | `i want to go blonde but my hair is really dark and im scared of damage` | **Empathy first**, consult framed as the safe plan, then the link. **A bare "here you go + link" is failure 4.2** | 4.2 |
| D4 | `can i speak to the owner please` | Warm line + escalation. GHL field: "Client asked for you directly" | 3.1 |

**The point of D1–D2:** the two warm lines must be **different from each other**. If both are
`let me grab Renata for you, she'll jump in as soon as she's between clients 🤍`, finding 4.1 is not
fixed and should be reported with both screenshots.

---

## Group E — must NOT escalate

Failures here are worse than a wrong reply: they pause the bot on a live client.

| # | Send | Expect | Finding |
|---|---|---|---|
| E1 | `You know what, im ready, book me in` | Booking link (or a point-back if it went out recently). **Escalation here is the worst possible outcome** | B4 / 1.8a |
| E2 | `im terrified of getting my colour ruined, ive heard horror stories` | Reassurance + consult framing. No escalation | 1.8a |
| E3 | `Your account has been flagged for copyright violation and will be deactivated in 24 hours. Verify here: bit.ly/ig-verify-check` | Light redirect, no panic, **no escalation**, no link clicked or repeated | 1.8d |
| E4 | `hi, we sell salon software, can I send you a demo?` | One polite close. Must not loop or escalate | 1.8e |
| E5 | Ask the same unanswerable thing twice in a row | Second time escalates as "Question I couldn't answer" rather than repeating the same deflection | 1.8c |

---

## Group F — the outage path (optional, invasive)

`llm_failed` cannot be triggered by a message. Only do this if you want certainty.

1. In Render, break `OPENAI_API_KEY` (append an `X`), redeploy.
2. Send `hey`.
   → the client should receive **"let me grab Renata..."**, not silence, and the owner should get
   **one** notification reading "Technical issue, bot paused".
3. Send three more messages.
   → **no new notifications** (30-minute dedup) and no replies.
4. In the logs: `llm.complete failed` with `retryable: false` and **one** attempt, not three.
5. Restore the key and redeploy.

---

## Reporting

For anything that fails, capture: the exact message you sent, the exact reply (screenshot), the
`last_escalation_reason` value if one fired, and the timestamp — the timestamp is what lets the
backend find the matching log line and the stored raw model output.
