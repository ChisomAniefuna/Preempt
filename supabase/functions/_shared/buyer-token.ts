// Buyer link token: base64url("offerId.expiresAtMs").HMAC-SHA256. Only its SHA-256 hash is stored.
const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

const key = (secret: string, usage: KeyUsage[]) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);

export async function signToken(offerId: string, expiresAtMs: number, secret: string): Promise<string> {
  const payload = b64(enc.encode(`${offerId}.${expiresAtMs}`));
  const sig = await crypto.subtle.sign('HMAC', await key(secret, ['sign']), enc.encode(payload));
  return `${payload}.${b64(sig)}`;
}

export type TokenCheck = { ok: true; offerId: string; expiresAtMs: number } | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' };

/** Verifies the signature only. Expiry is the caller's decision, so expired links can still say so. */
export async function verifyToken(token: string, secret: string): Promise<TokenCheck> {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'MALFORMED' };
  const [payload, sig] = parts;
  try {
    const raw = Uint8Array.from(unb64(sig), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', await key(secret, ['verify']), raw, enc.encode(payload)); // constant-time
    if (!valid) return { ok: false, reason: 'BAD_SIGNATURE' };
    const [offerId, exp] = unb64(payload).split('.');
    const expiresAtMs = Number(exp);
    if (!offerId || !Number.isFinite(expiresAtMs)) return { ok: false, reason: 'MALFORMED' };
    return { ok: true, offerId, expiresAtMs };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}

export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
