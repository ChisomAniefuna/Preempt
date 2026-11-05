# Preempt backend (Supabase)

Postgres + Auth + Realtime + Edge Functions (Deno) + Cron. The web app in `../web` only reads (under row level security) and calls these functions.

| Piece | What it does |
|---|---|
| `migrations/` | schema, RLS and the `dashboard_totals` view, cron + realtime, worker RPCs (`claim_*`, `complete_refund`, `shift_demo_time`) |
| `functions/_shared/validator.ts` | pure policy checks: allowed remedies, refund cap (lowest of dollars, percent, remaining capture), ETA window, message amounts/dates/links |
| `functions/_shared/executor.ts` | the only code that refunds or writes tracking; re-validates, refuses on dispute, one transaction via `complete_refund` |
| `functions/_shared/agent/` | `assess`, `propose`, `message`, `interpret` (Vercel AI SDK `generateObject` + Zod). The model never gets a PayPal client |
| `functions/_shared/tick.ts` | the 30-second loop; every step is idempotent and claimed with leases |
| `functions/{paypal-webhook,worker-tick,buyer,offers,demo}` | the five entry points (see `../docs/edge-function-contract.md`) |

## Deploy

```bash
supabase login && supabase link --project-ref <ref>
supabase db push
supabase secrets set --env-file supabase/.env          # copy .env.example first
supabase functions deploy paypal-webhook worker-tick buyer --no-verify-jwt
supabase functions deploy offers demo
```

Then, in the SQL editor, store the two Vault secrets the cron job reads (`project_url`, `cron_secret`; see `migrations/20261023000200_cron.sql`), create the auth user `demo@preempt.example`, run `seed.sql`, and register `https://<ref>.supabase.co/functions/v1/paypal-webhook` as the sandbox webhook (subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`).

## Tests

```bash
deno task test                         # 33 tests: validator, rules, carrier sim, tokens, executor idempotency, PayPal retry, agent evals
deno task check                        # typecheck every function
cd tests/sql && npm i && npm test      # 18 checks against a real Postgres (PGlite): RLS, constraints, RPCs
```


## Run it locally (verified end to end)

```bash
supabase start -x studio,imgproxy,logflare,vector,supavisor,postgres-meta,mailpit,storage-api   # first run pulls images; several minutes
supabase db reset                                   # migrations + seed (the seed needs the auth user, see below)
cp supabase/.env.example supabase/.env             # fill in keys, or use the keyless mocks in supabase/dev/
supabase functions serve --env-file supabase/.env

# one-time: demo merchant, then seed, then the three Vault secrets the cron job reads
curl -X POST http://127.0.0.1:54321/auth/v1/admin/users -H "apikey: <service role key>" -H "Authorization: Bearer <service role key>" \
     -H 'Content-Type: application/json' -d '{"email":"demo@preempt.example","password":"<choose one>","email_confirm":true}'
supabase db reset                                   # or run supabase/seed.sql again now that the user exists
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
  select vault.create_secret('http://api.supabase.internal:8000', 'project_url');
  select vault.create_secret('<CRON_SECRET from supabase/.env>', 'cron_secret');
  select vault.create_secret('<anon key from supabase status>', 'anon_key');"

cd web && cp .env.example .env.local && npm ci && npm run dev -- -p 3100
```

Things the first live run taught us:

- **Every function call needs an `apikey` header**, even functions with `verify_jwt = false`: the local gateway rejects the request before it reaches the function. The cron job therefore sends the anon key (Vault secret `anon_key`); without it every scheduled tick got `401`. On hosted Supabase a `verify_jwt = false` function is callable with no headers, so PayPal's webhook works there. Locally, test webhooks with `curl -H "apikey: ..."` or a tunnel that adds the header.
- **Port 3000 may be taken** by another app. Run the web app on another port and set `APP_BASE_URL` in `supabase/.env` to match, because buyer links are built from it.
- Functions run in Docker, so a service on your machine is `host.docker.internal`, not `localhost`.
- The demo's "Advance carrier clock" shifts history cumulatively, so after several advances older orders show "last scan 17 days ago". That is expected.

Verified live this way: sign-in, `demo/scenario`, `demo/advance`, rule flag, assess, blocked then corrected proposal, signed buyer link (tampered link refused, second choice refused), buyer choice, **cron-driven auto-approve and refund**, merchant edit (over-cap and remedy change refused), **three simultaneous approvals produced one PayPal refund**, free-text injection reply (no action, escalated), duplicate dispute webhook (stored once), dispute stops outreach and execution, reship through the UI, dashboard totals matching the database. The PayPal and model endpoints were the local mocks in `supabase/dev/`.

## Design notes and deviations from the technical PRD

- **PayPal read tools are hand-written**, not `@paypal/agent-toolkit` (the PRD's documented fallback): the toolkit could not be verified under Deno. The assessment step receives PayPal facts fetched by code through two read-only functions, so the model is never handed any tool, and refunds exist only inside the executor.
- **Demo clock:** "Advance carrier clock" moves the merchant's simulated shipments (and their promised dates, scans and offer expiries) into the past with `shift_demo_time`, so "now" stays real and the UI's "last scan 5 days ago" is true.
- **Approve runs the action immediately** (in the background) instead of waiting for the next tick; the action lease makes that safe.
- **Rejecting an offer** returns the incident to `OPEN` per the PRD, so the agent drafts a different offer (max three per incident).
- **Message fallback:** if two model drafts fail validation, a deterministic template built only from the approved options is sent.
- **Not built:** FR15 buyer reminder after 48 hours (Stretch), real carrier feeds.

## Verified vs not verified

Verified: all pure logic and the executor (Deno tests with fakes), every function typechecks (`deno check`), and the SQL runs on a real Postgres engine.
**Not run:** any real PayPal sandbox call, any real LLM call, real PayPal webhooks (signature verification was exercised against the mock), and the Resend email path. The functions themselves have run end to end on a live local Supabase stack (see above).
