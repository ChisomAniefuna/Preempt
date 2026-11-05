# Preempt

An AI agent that watches a merchant's shipments and fixes late or failed orders with the buyer **before** the buyer opens a PayPal dispute. The agent proposes; code enforces limits and moves money.

*Dispute tools help you win the fight. Preempt makes sure there is no fight.*

## Run it

Requires Node 22.13+. No npm dependencies.

```bash
npm test        # 25 tests: rules, validator, idempotency, guardrails
npm run demo    # the whole loop in the terminal, ~1 second
npm start       # http://localhost:3000
```

In the UI: open **/dev**, seed a scenario, press *Advance and poll*, then use **/merchant** (inbox), the buyer link shown in the incident's messages, **/policy** and **/dashboard**.

Configuration is via environment variables (see `.env.example`; export them before `npm start`).

| Variable | Effect |
|---|---|
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Switch from the PayPal mock to the real **sandbox** REST API |
| `PAYPAL_WEBHOOK_ID` | Verify real webhook signatures on `POST /webhooks/paypal` |
| `ANTHROPIC_API_KEY` | Use Claude (`PREEMPT_MODEL`, default `claude-sonnet-5-5`) for assessment, proposals and reply reading. Without it a deterministic fallback agent runs. |

## How the loop works

```
carrier feed -> rules (FR4) -> AI assess (FR5) -> AI propose -> VALIDATOR --blocked--> back to AI (max 3)
                                                                   | ok
                                          message check -> buyer link (FR8) -> buyer picks
                                                   auto-approve (small) / merchant approve (FR9)
                                                              EXECUTOR (only holder of refund access, FR10-11)
```

- `src/rules.js` deterministic risk rules: `no_scan`, `delivery_delayed`, `delivery_failed`, `returned`, `promised_date_passed`.
- `src/policy.js` merchant policy, **validator** (type allowed, percent + dollar cap, remaining capture, ETA window), and a message checker that rejects any amount or date not in the approved offers.
- `src/agent.js` gets only `paypal.read` (order, tracking, dispute lookups). Buyer text is classified into a choice among existing offers, never executed.
- `src/executor.js` the only module given `paypal.money`. Requires a one-time approval token, re-validates, and claims the incident atomically, so replayed approvals and concurrent calls refund once (also `PayPal-Request-Id` per incident).
- `src/engine.js` incident lifecycle, dispute watch (FR14), dashboard (FR13). Everything is written to `audit_log` (FR12).

## Status against the PRD

MVP FR1-FR13 and FR14 (dispute watch) are implemented. Not built: FR15 buyer reminder, FR16, FR17.

## Honest limits

- **Real PayPal sandbox calls are written but untested** (no sandbox credentials were available while building). Mock mode is what the tests and demo exercise. Verify refund, tracking and webhook calls in your sandbox before the demo, and check Nigeria eligibility per the PRD.
- Buyer messages are stored and logged, not emailed. Plug an email sender into `say()` in `src/engine.js`.
- The merchant pages have no login. Add auth before exposing the server publicly.
- Carrier data is the simulated feed (`sim_timelines`).
- Reship uses a placeholder tracking number unless the merchant supplies one.
