import { auditTo } from './audit.ts';
import { createLlm, type Llm } from './agent/llm.ts';
import { env, envOpt } from './env.ts';
import { createPayPal } from './paypal/client.ts';
import { adminClient } from './supabase-admin.ts';
import type { TickDeps } from './tick.ts';

export const makePayPal = () => createPayPal({ clientId: env('PAYPAL_CLIENT_ID'), clientSecret: env('PAYPAL_CLIENT_SECRET'), base: envOpt('PAYPAL_API_BASE') ?? 'https://api-m.sandbox.paypal.com' });

let llm: Promise<Llm> | undefined;

export function makeTickDeps(admin = adminClient()): TickDeps {
  return {
    admin,
    paypal: makePayPal(),
    audit: auditTo(admin),
    getLlm: () => (llm ??= createLlm()),
    appBaseUrl: env('APP_BASE_URL'),
    tokenSecret: env('BUYER_LINK_SECRET'),
  };
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
