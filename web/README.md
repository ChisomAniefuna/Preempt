# Preempt web app

Next.js 15 (App Router, TypeScript, Tailwind) front end. Reads Supabase under row level security; every write goes through an Edge Function (see `../docs/edge-function-contract.md`).

```bash
cp .env.example .env.local   # Supabase URL, anon key, functions URL
npm ci
npm run dev                  # http://localhost:3000
npm run typecheck && npm test && npm run build
```

| Route | Who | Notes |
|---|---|---|
| `/login` | merchant | Supabase email and password |
| `/inbox`, `/inbox/[id]` | merchant | live via Realtime; approve, edit, reject; validator banner; PayPal ID chips; audit trail |
| `/policy` | merchant | writes `policies` directly (RLS) |
| `/dashboard` | merchant | reads the `dashboard_totals` view |
| `/demo` | presenter | run scenarios, advance the carrier clock |
| `/b/[token]` | buyer | public, phone first; talks to the `buyer` function |

Only the anon key is used in the browser. The service role key never appears in this app.
