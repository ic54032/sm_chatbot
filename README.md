# Salon Receptionist V1 Mock

AI receptionist for hair salons — V1 mock phase. See [design doc](docs/superpowers/specs/2026-05-09-salon-receptionist-v1-mock-design.md).

## Dev quickstart

```bash
cp .env.example .env       # fill in ANTHROPIC_API_KEY
docker compose up -d        # postgres + redis
npm install
npm run migrate:up
npm run dev
```

Smoke test:
```bash
curl -X POST http://localhost:3000/dev/simulate-inbound \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: dev-secret-change-me" \
  -d '{"location_id":"loc_1","contact_id":"c_1","message_text":"hello"}'
```
