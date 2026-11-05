-- Supabase Cron calls worker-tick every 30 seconds. Store `project_url` and `cron_secret` in Vault first:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'cron_secret');
--   select vault.create_secret('<the project anon (publishable) key>', 'anon_key');
-- The anon key is public. The API gateway wants an apikey/Authorization header on every function call
-- (the local stack enforces it even for functions with JWT checks off); worker-tick's own check is x-cron-secret.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'worker-tick',
  '30 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/worker-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

alter publication supabase_realtime add table incidents, offers, actions, audit_events;
