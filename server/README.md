# ai-code-server

Backend for the fork. Runs auth, billing/quota, model proxy, sync, jobs, telemetry.

## Run

```
cd server
npm install
cp .env.example .env  # fill in values
npm run dev
```

Required env:
- `JWT_SECRET` — for session tokens
- `ANTHROPIC_API_KEY` — proxied for users
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — OAuth app
- `PUBLIC_URL` — e.g. `http://localhost:8787`
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRO_PRICE_ID` — for billing (optional)

## Endpoints

- `GET /auth/start` — kicks off GitHub OAuth
- `GET /auth/callback` — receives `code`, returns a one-time exchange code
- `POST /auth/exchange` — `{code}` → `{token, user, plan}`
- `POST /v1/messages` — proxied Anthropic call (auth required, quota enforced, usage logged)
- `POST /billing/checkout` — Stripe checkout session (auth required)
- `POST /billing/webhook` — Stripe webhook
- `POST /sync/memory` / `GET /sync/memory?workspace=...` — sync `.aicode/memory.md`, `rules.md`
- `POST /jobs` / `GET /jobs/:id` — queue background agent jobs (executor not included)
- `POST /telemetry` — batched event ingest

## What's still stubbed

- Job executor: rows are written but nothing pulls and runs them. Plug in Fly Machines, Modal, or a worker pool.
- Email auth: only GitHub OAuth wired up.
- Embedding/index sync: not implemented; index lives client-side.
