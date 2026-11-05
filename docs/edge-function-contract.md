# Edge Function contract used by the web app

The Next.js app reads rows straight from Postgres under row level security and calls these Edge Functions for every write.
Errors use `{ "error": { "code", "message", "details": [] } }` (codes: `POLICY_VIOLATION`, `ALREADY_EXECUTED`, `PAYPAL_ERROR`, `TOKEN_EXPIRED`, `DISPUTE_OPEN`).
`details` entries may be strings or `{ code?, message }`; the UI shows them as a list.

| Call | Auth | Body | Response |
|---|---|---|---|
| `GET /buyer?token=` | signed token | n/a | `BuyerView` (see `web/lib/types.ts`): `status` OPEN, CHOSEN, RESOLVED or EXPIRED, `merchant_name`, `buyer_name`, `merchant_order_id`, `message`, `options[]`, `chosen?`, `reply_ack?`. Expired token: HTTP 410 with `TOKEN_EXPIRED` |
| `POST /buyer/choose` | signed token | `{ token, choice_index }` or `{ token, reply }` | the updated `BuyerView` (`status: CHOSEN`) |
| `POST /offers/{id}/approve` | merchant JWT | none | 2xx on success. Also used for **Retry** on `ACTION_FAILED` (same idempotency key) |
| `POST /offers/{id}/reject` | merchant JWT | `{ note? }` | 2xx; incident returns to `OPEN` |
| `PATCH /offers/{id}` | merchant JWT | `{ choice: Option }` (edited amount or ETA) | 2xx, or 4xx `POLICY_VIOLATION` with `details` when the validator rejects the edit |
| `POST /demo/scenario` | merchant JWT | `{ scenario: stall \| failed \| returned \| on_time }` | `{ order: { merchant_order_id, paypal_order_id, capture_id }, tracker_id }` |
| `POST /demo/advance` | merchant JWT | `{ days }` | 2xx after jumping the simulated clock and running `worker-tick` |

Option shape (`offers.options`, `offers.buyer_choice`): `{ type: NEW_ETA | RESHIP | PARTIAL_REFUND | FULL_REFUND, amount_cents?, new_eta? (YYYY-MM-DD), rationale? }`.
Incident states used by the UI: `OPEN, OFFERED, AWAITING_APPROVAL, EXECUTING, RESOLVED, NEEDS_MERCHANT, EXPIRED, DISPUTED, ACTION_FAILED`.
Offer statuses: `DRAFT, BLOCKED, SENT, CHOSEN, APPROVED, REJECTED, EXPIRED`. Actions: `type REFUND | RESHIP | NEW_ETA`, `status PENDING | COMPLETED | FAILED`.

## As implemented (`supabase/functions`)

- `paypal-webhook` (no JWT): verifies with PayPal, stores by event id (duplicates ignored), answers `{ received, verified }`. Unverified events are stored and never acted on.
- `worker-tick` (`x-cron-secret`): `applyWebhooks, pollCarriers, runRules, assessAndPropose, interpretReplies, autoApprove, execute, expireOffers`. Returns a summary with per-step errors.
- `buyer` (signed token): `GET ?token=` returns `BuyerView` (HTTP 410 `TOKEN_EXPIRED` once the link expires); `POST /choose` takes `{ token, choice_index }` or `{ token, reply }`. A reply is interpreted by the agent on the next tick and either becomes the buyer's choice or sends the incident to the merchant. Rate limited per IP.
- `offers` (merchant JWT): `POST /{id}/approve` returns `{ ok, action_id }` and starts execution in the background; `POST /{id}/reject` returns the incident to `OPEN` and records the note, so the agent drafts a different offer (at most three offers per incident, then `NEEDS_MERCHANT`); `PATCH /{id}` changes the amount or date of the buyer's chosen remedy (never the remedy) after re-validating it.
- `demo` (merchant JWT): `POST /scenario` accepts an optional `{ order_id, capture_id }` to reuse an existing sandbox payment; `POST /advance` moves the merchant's simulated shipments `days` into the past, then runs one tick and returns `{ ok, days, tick }`.
- Retrying an `ACTION_FAILED` incident is `POST /offers/{id}/approve` again; it reuses the action's idempotency key.
- The signed buyer link is written to the audit trail (`BUYER_LINK_CREATED`) so the incident screen can show it.
