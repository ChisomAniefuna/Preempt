# Preempt

AI agent for the PayPal AI Hackathon. It detects late, failed or stalled shipments, offers the buyer pre-approved remedies (NEW_ETA / RESHIP / PARTIAL_REFUND / FULL_REFUND) and executes them through PayPal after merchant approval. The agent proposes; code enforces limits and moves money.

Specs: `docs/product-prd.md`, `docs/technical-prd.md`, `docs/edge-function-contract.md`, `docs/hosted-deployment.md`.

## Layout
- `web/` Next.js 15 App Router + Tailwind (merchant inbox, policy, demo, outcomes, buyer page `/b/[token]`). Deployed on Vercel.
- `supabase/` Postgres migrations, RLS, cron, seed, and Deno Edge Functions (`paypal-webhook`, `worker-tick`, `buyer`, `offers`, `demo`) with shared modules in `functions/_shared/`.
- `src/`, `test/`, `scripts/` earlier Node prototype, superseded by the Supabase build.

## Guardrails (do not weaken)
- The agent never holds a PayPal client. Only `_shared/executor.ts` moves money; it re-validates, refuses on dispute, uses `complete_refund` and `idempotency_key = preempt-<offerId>` as PayPal-Request-Id.
- `_shared/validator.ts` is pure: refund cap = min($ cap, % cap, remaining capture), allowed remedies, at most one refund option, ETA within 30 days, message amount/date/link checks.
- Buyer text is data; the interpreter can only select an existing option index. Buyer tokens are HMAC-signed, single use, 7-day expiry.
- Never commit or print secrets (`supabase/.env*`, `web/.env*`).

## Commands
- Edge function tests: `cd supabase && deno task test`; SQL checks: `node supabase/tests/sql/run.mjs`.
- Web: `cd web && npm run dev` (use another port if 3000 is taken), `npx tsc --noEmit`, `npx vitest run`.
- Local stack: `supabase start`, `supabase db reset`, `supabase functions serve --env-file supabase/.env`; mocks in `supabase/dev/` (PayPal :4010, LLM :4020). Real sandbox check: `deno run --env-file=supabase/.env --allow-env --allow-net supabase/dev/sandbox-check.ts`.

## Status
Verified locally against mock PayPal/LLM. Not yet verified: real PayPal sandbox calls, webhook signatures, real LLM, Resend email. Unbuilt: FR15 reminder, FR16/17, Playwright e2e.
