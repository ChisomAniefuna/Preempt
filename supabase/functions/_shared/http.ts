export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
};

export type ErrorCode = 'POLICY_VIOLATION' | 'ALREADY_EXECUTED' | 'PAYPAL_ERROR' | 'TOKEN_EXPIRED' | 'DISPUTE_OPEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'INTERNAL';

export class HttpError extends Error {
  constructor(public status: number, public code: ErrorCode, message: string, public details: unknown[] = []) { super(message); }
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export const errorResponse = (e: unknown): Response => {
  if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status);
  console.error(e);
  return json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', details: [] } }, 500);
};

/** Wraps a handler with CORS preflight and the shared error format. */
export const handler = (fn: (req: Request) => Promise<Response>) => async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try { return await fn(req); } catch (e) { return errorResponse(e); }
};

/** Path segments after the function name: /functions/v1/offers/abc/approve -> ['abc', 'approve']. */
export const subpath = (req: Request, fn: string): string[] => {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = parts.indexOf(fn);
  return i === -1 ? [] : parts.slice(i + 1);
};

/** Awaits a single-row query and throws if the row is missing (keeps non-null types honest). */
// deno-lint-ignore no-explicit-any
export async function one(q: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<any> {
  const { data, error } = await q;
  if (error || !data) throw new Error(error?.message ?? 'Expected a row but found none.');
  return data;
}
