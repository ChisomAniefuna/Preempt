# Keyless local run

Two tiny stand-ins let the whole loop run on `supabase start` with no PayPal or LLM credentials. They are for development only; the judged demo uses the real PayPal sandbox and a real model.

```bash
node supabase/dev/paypal-mock.mjs   # :4010  OAuth, orders, track, refund (idempotent by PayPal-Request-Id), disputes, webhook verify
node supabase/dev/llm-mock.mjs      # :4020  Anthropic Messages API: assess / propose / message / interpret
```

`supabase/.env` for this mode (the functions run in Docker, so the host is `host.docker.internal`):

```
PAYPAL_CLIENT_ID=mock-client
PAYPAL_CLIENT_SECRET=mock-secret
PAYPAL_API_BASE=http://host.docker.internal:4010
PAYPAL_WEBHOOK_ID=mock-webhook
ANTHROPIC_API_KEY=mock-key
ANTHROPIC_BASE_URL=http://host.docker.internal:4020/v1
```

The mock model's first proposal for every incident is deliberately greedy (a refund of the whole order), so you always see the validator block it and the retry pass. `GET :4010/_log` shows every PayPal call it received and the total refunded per capture.
