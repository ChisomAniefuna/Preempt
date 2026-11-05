import { envOpt } from './env.ts';

/** Sends the buyer email through Resend. Without RESEND_API_KEY it only logs (the link is also in the audit trail). */
export async function sendBuyerEmail(to: string, subject: string, text: string): Promise<{ sent: boolean; error?: string }> {
  const key = envOpt('RESEND_API_KEY');
  if (!key) { console.log(`[email not configured] to=${to} subject=${subject}`); return { sent: false, error: 'RESEND_API_KEY not set' }; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: envOpt('EMAIL_FROM') ?? 'Preempt <onboarding@resend.dev>', to: [to], subject, text }),
    });
    if (!res.ok) return { sent: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String((e as Error).message ?? e) };
  }
}
