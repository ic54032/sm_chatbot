# Runbook: dead account / reconnect

The failure that kills trust fastest: a salon's Instagram DMs silently stop
reaching the bot. Clients message, nobody answers, the owner finds out days
later. This runbook covers detecting it, diagnosing which link in the chain
broke, and reconnecting.

## How you find out

1. **Daily health check** (07:00 UTC, `src/workers/health-check.ts`) posts to
   the ops webhook (`OPS_ALERT_WEBHOOK_URL`) and writes `ops_alert: true` log
   lines. Two alert types:
   - `salon_disabled` (critical) — `salons.is_active = false`. Almost always
     the automatic kill switch: a GHL API call returned 401/403 (dead PIT) and
     the backend disabled the salon to stop failing sends.
   - `inbound_flatline_24h` (warning) — an account averaging ≥ `HEALTHCHECK_MIN_DAILY_AVG`
     (default 2) inbound DMs/day received **zero** in 24h. Our side sees no
     errors — silence upstream is the only symptom. Usual culprits: GHL
     workflow turned off / broken merge tags, or IG disconnected from GHL.
2. **An owner or tester reports** the bot stopped replying. Treat it as the
   same triage below.

## Triage — find the broken link

The chain: **IG → GHL inbox → GHL workflow → webhook → backend → LLM → GHL send → IG**

Work through it in order; each step isolates half the chain.

1. **Render logs** (dashboard → service → Logs). Send a test DM to the salon's
   IG and watch for `http request received` on `/webhooks/ghl/inbound` within
   seconds.
   - **Log line appears** → upstream is fine; the problem is on our side.
     Follow the log for that request: `inbound classification debug` →
     `respond job queued` → `llm response received` → `sending message to ghl`.
     The first missing/erroring step names the culprit:
     - `salon not found for inbound; dropping` → salon row inactive or
       location_id mismatch → see **Re-enable a disabled salon**.
     - `handoff active; bot paused` → not a failure; an escalation window is
       open. `handoff_until` in the conversations row shows until when.
     - GHL send error 401/403 → dead PIT → see **Rotate the PIT**.
     - Job queued but worker never picks it up → Redis issue → see
       **Restart the service**.
   - **No log line** → the webhook never fired. Continue below.
2. **GHL inbox** (app.gohighlevel.com → Conversations): did the test DM arrive
   in GHL at all?
   - **Not in GHL** → IG ↔ GHL connection is down → see **Reconnect Instagram**.
   - **In GHL but no webhook** → the workflow is broken → see **Fix the GHL
     workflow**.

## Fixes

### Reconnect Instagram to GHL
1. GHL → Settings → Integrations → Facebook/Instagram.
2. If the IG account shows disconnected/expired: Reconnect, log in with the
   salon's linked Facebook account, re-grant messaging permissions.
   (Meta forces re-auth periodically and on password/2FA changes — this is the
   most common silent breakage.)
3. Verify: send a test DM → it appears in GHL Conversations.

### Fix the GHL workflow
1. GHL → Automation → Workflows → the inbound-DM workflow.
2. Check it is **Published**, trigger is Instagram DM inbound, and the Custom
   Webhook action posts to `https://<render-service>/webhooks/ghl/inbound`.
3. Check the payload fields still resolve — GHL platform updates have broken
   merge tags before (location_id must be hardcoded; `{{contact.id}}`,
   `{{message.body}}`, `{{message.attachments}}` must render real values, not
   literal `null`). Use the workflow's test/execution log to inspect a run.
4. Verify end-to-end: test DM → `inbound classification debug` in Render logs
   with non-empty payload values.

### Rotate the PIT (dead token)
1. GHL → Settings → Private Integrations → create/rotate the token (scopes:
   conversations read/write, contacts read/write).
2. Encrypt & store it (uses `PIT_ENCRYPTION_KEY` from Render env):
   `DATABASE_URL='<prod-url>' npx tsx scripts/encrypt-existing-pits.ts` after
   updating the row, or update via the admin route with the plaintext PIT —
   it encrypts on write.
3. Re-enable the salon (the 401/403 kill switch disabled it) — next section.

### Re-enable a disabled salon
Only after the root cause is fixed, otherwise it will disable itself again on
the next send:

```sql
UPDATE salons SET is_active = true, updated_at = now() WHERE id = '<salon-id>';
```

### Restart the service
Render dashboard → service → Manual Deploy → "Clear build cache & deploy" is
rarely needed; plain **Restart** covers stuck Redis consumers/workers. Redis
data (queues) survives; delayed respond jobs are re-created per new inbound.

## Verify the fix (always, before walking away)

1. Send a test DM from a non-owner IG account.
2. Render logs: full chain `inbound classification debug` → `respond job
   queued` → `llm response received` → `sending message to ghl`.
3. The reply arrives on IG within ~15s (10s batching delay + processing).
4. If the account had `salon_disabled`: confirm the next daily health check is
   quiet (or run the SQL from the alert detail to spot-check `is_active`).

## Knobs

| Env var | Default | Meaning |
|---|---|---|
| `OPS_ALERT_WEBHOOK_URL` | unset (logs only) | Slack/Discord incoming webhook for alerts |
| `HEALTHCHECK_MIN_DAILY_AVG` | 2 | Baseline avg (inbound/day over prior 14d) below which a silent 24h is NOT alerted |

Future hardening (not built): proactive PIT probe (cheap authenticated GHL
call per salon in the daily tick) to catch dead tokens before a client
messages; per-salon overrides for the flatline threshold.
