# Hosted Preempt deployment

Deployed on 4 November 2026.

- Frontend: https://preempt-rosy.vercel.app
- Vercel project: https://vercel.com/aniefuns-projects/preempt
- Supabase project: https://supabase.com/dashboard/project/jjvbmxdzoeqcrhhbazhy
- Supabase API: https://jjvbmxdzoeqcrhhbazhy.supabase.co
- Region: London (eu-west-2).

The frontend was uploaded directly from `web/`. This folder has no Git repository, so automatic Git deployments are not configured. Vercel uses Next.js and Node 22, with the hosted Supabase public environment variables configured.

All four original migrations plus the function permissions migration are applied. All five Edge Functions are deployed. Realtime is configured. The `worker-tick` Cron job is deliberately inactive pending provider configuration. Vault contains the project URL, public anon key and matching generated cron secret.

## Complete runtime configuration

1. Open `supabase/.env.production` locally. It contains generated buyer-link and cron secrets and the deployed frontend URL. Fill in real PayPal **sandbox** client ID, client secret and webhook ID, plus an Anthropic API key and a model available to that account. Local mock credentials and localhost endpoints cannot work in the hosted project. Keep this file private; it is ignored by Git.
2. Paste the settings into https://supabase.com/dashboard/project/jjvbmxdzoeqcrhhbazhy/functions/secrets and save. The generated `CRON_SECRET` must remain the same as the value already stored in Vault.
3. The confirmed demo account `demo@preempt.example` and its merchant and policy are now created. Its password was set as requested in the chat. Password sign-in was verified against the hosted Auth API.
4. Set the Supabase Auth site URL to `https://preempt-rosy.vercel.app` in Authentication > URL Configuration.
5. Register `https://jjvbmxdzoeqcrhhbazhy.supabase.co/functions/v1/paypal-webhook` in the PayPal sandbox for capture completed/refunded and dispute created/updated/resolved events. Set its resulting webhook ID in the function secrets.
6. Verify login and a sandbox scenario before enabling the worker. Enable it with:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'worker-tick'),
  active := true
);
```

Email delivery is optional: configure `RESEND_API_KEY` and `EMAIL_FROM` if desired. Without email delivery, the buyer link is available in the incident view.

## Validation

The frontend passed TypeScript checks, seven Vitest tests, and a local production build. Vercel reports the production deployment READY, and the login page returns HTTP 200. All five Edge Functions report ACTIVE. Provider calls and a signed-in end-to-end flow remain unverified until credentials and the demo user are configured.
