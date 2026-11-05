# SQL checks

Applies the migrations to an in-process Postgres (PGlite, no Docker) with stubs for Supabase's `auth` schema and roles,
then checks the one-open-incident index, the refund check constraint, the append-only audit log, row level security
(a second merchant sees nothing; the browser role cannot write or call the privileged functions), the claim functions,
atomic `complete_refund`, the dashboard view and `shift_demo_time`.

```bash
cd supabase/tests/sql && npm i && npm test
```

The cron migration is skipped (it needs `pg_cron` and Vault). Run `supabase db reset` against the real stack too.
