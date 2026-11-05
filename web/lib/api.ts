import { createClient } from './supabase/client';

export class ApiError extends Error {
  constructor(public code: string, message: string, public details: unknown[] = []) { super(message); }
}

const BASE = process.env.NEXT_PUBLIC_FUNCTIONS_URL!;

/** Calls an Edge Function. Merchant routes send the session JWT; buyer routes pass `auth: false`. */
export async function callFunction<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! };
  if (opts.auth !== false) {
    const { data } = await createClient().auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError('NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details ?? []);
  }
  return json as T;
}
