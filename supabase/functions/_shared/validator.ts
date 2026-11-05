// The validator: pure functions, no I/O. Everything the model proposes passes through here,
// and the executor calls it again right before money moves.
import { addDays, type Option, type OrderFacts, type Policy, REMEDIES, usd, type Violation, ymd } from './types.ts';

export const MAX_ETA_DAYS = 30;

/** Hard refund cap: the lowest of the dollar cap, the percent cap, and what is left on the capture. */
export function maxRefundCents(policy: Policy, order: Pick<OrderFacts, 'amount_cents' | 'refunded_cents'>): number {
  const byPercent = Math.floor((order.amount_cents * policy.max_refund_percent) / 100);
  const remaining = order.amount_cents - order.refunded_cents;
  return Math.max(0, Math.min(policy.max_refund_cents, byPercent, remaining));
}

export interface OptionCheckCtx { policy: Policy; order: OrderFacts; now: Date; disputeOpen?: boolean }
export interface OptionCheck { ok: boolean; accepted: Option[]; violations: Violation[] }

export function validateOptions(options: unknown, ctx: OptionCheckCtx): OptionCheck {
  const violations: Violation[] = [];
  const accepted: Option[] = [];
  const list = Array.isArray(options) ? options : [];
  if (ctx.disputeOpen) violations.push({ code: 'DISPUTE_OPEN', message: 'A dispute is already open on this order; nothing may be offered.' });
  if (list.length === 0) violations.push({ code: 'NO_OPTIONS', message: 'No remedies were proposed.' });
  if (list.length > 3) violations.push({ code: 'TOO_MANY', message: 'More than three remedies were proposed.' });

  const seen = new Set<string>();
  let refundOptions = 0;
  list.slice(0, 3).forEach((raw, index) => {
    const bad = (code: string, message: string) => violations.push({ code, message, index });
    const o = raw as Option;
    if (!o || typeof o !== 'object') return bad('MALFORMED', 'Option is not an object.');
    if (!REMEDIES.includes(o.type)) return bad('UNKNOWN_TYPE', `Unknown remedy "${o.type}".`);
    if (!ctx.policy.allowed_remedies.includes(o.type)) return bad('NOT_ALLOWED', `${o.type} is not on the merchant's allowed list.`);
    if (seen.has(o.type)) return bad('DUPLICATE', `${o.type} was offered twice.`);
    const err = checkOne(o, ctx);
    if (err) return bad(err.code, err.message);
    if (o.type === 'PARTIAL_REFUND' || o.type === 'FULL_REFUND') {
      refundOptions++;
      if (refundOptions > 1) return bad('ONE_REFUND_ONLY', 'Only one refund option may be offered at a time.');
    }
    seen.add(o.type);
    accepted.push(o);
  });
  return { ok: violations.length === 0 && accepted.length > 0, accepted, violations };
}

/** Checks a single option's numbers. Shared by option validation, merchant edits and the executor. */
function checkOne(o: Option, { policy, order, now }: OptionCheckCtx): { code: string; message: string } | null {
  if (o.type === 'PARTIAL_REFUND') {
    const cap = maxRefundCents(policy, order);
    if (!Number.isInteger(o.amount_cents) || (o.amount_cents as number) <= 0) return { code: 'BAD_AMOUNT', message: 'A refund must be a positive whole number of cents.' };
    if ((o.amount_cents as number) > cap) return { code: 'OVER_CAP', message: `Refund of ${usd(o.amount_cents as number)} exceeds the cap of ${usd(cap)}.` };
  }
  if (o.type === 'FULL_REFUND') {
    const left = order.amount_cents - order.refunded_cents;
    if (left <= 0) return { code: 'NOTHING_TO_REFUND', message: 'The capture is already fully refunded.' };
    if (o.amount_cents !== left) return { code: 'BAD_AMOUNT', message: `A full refund must equal the remaining ${usd(left)}.` };
  }
  if (o.type === 'NEW_ETA') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.new_eta ?? '') || Number.isNaN(Date.parse(o.new_eta!))) return { code: 'BAD_ETA', message: 'The new delivery date must be a YYYY-MM-DD date.' };
    if (o.new_eta! <= ymd(now)) return { code: 'ETA_IN_PAST', message: 'The new delivery date must be after today.' };
    if (o.new_eta! > ymd(addDays(now, MAX_ETA_DAYS))) return { code: 'ETA_TOO_FAR', message: `The new delivery date is more than ${MAX_ETA_DAYS} days away.` };
  }
  return null;
}

/** Re-checks one chosen option (merchant edit, approval, execution). */
export function validateChoice(option: Option, ctx: OptionCheckCtx): { ok: boolean; violations: Violation[] } {
  const r = validateOptions([option], ctx);
  return { ok: r.ok, violations: r.violations };
}

// ---------------------------------------------------------------- message checks

export interface DraftMessage { subject: string; body: string; mentionedAmountsCents: number[]; mentionedDates: string[] }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthDay = (iso: string) => { const [, m, d] = iso.split('-').map(Number); return `${m}-${d}`; };

/**
 * Every amount and date a message mentions must match an approved option (or the order's own facts),
 * both in the declared arrays and in the free text. Links are not allowed: the app adds the only one.
 */
export function validateMessage(msg: DraftMessage, options: Option[], order: OrderFacts): { ok: boolean; violations: Violation[] } {
  const violations: Violation[] = [];
  const v = (code: string, message: string) => violations.push({ code, message });
  const okAmounts = new Set<number>([order.amount_cents, ...options.filter((o) => o.amount_cents != null).map((o) => o.amount_cents as number)]);
  const okDates = new Set<string>([monthDay(order.promised_by.slice(0, 10)), ...options.filter((o) => o.new_eta).map((o) => monthDay(o.new_eta!))]);

  for (const c of msg.mentionedAmountsCents) if (!okAmounts.has(c)) v('MSG_AMOUNT', `Declared amount ${usd(c)} is not part of any offer.`);
  for (const d of msg.mentionedDates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !okDates.has(monthDay(d))) v('MSG_DATE', `Declared date ${d} is not part of any offer.`);

  const text = `${msg.subject}\n${msg.body}`;
  for (const m of text.matchAll(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(?:USD|dollars)\b/gi)) {
    const cents = Math.round(parseFloat((m[1] ?? m[2]).replace(/,/g, '')) * 100);
    if (!okAmounts.has(cents)) v('MSG_AMOUNT', `The text mentions ${m[0].trim()}, which is not part of any offer.`);
  }
  const monthRe = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})\\b`, 'gi');
  for (const m of text.matchAll(monthRe)) {
    const key = `${MONTHS.indexOf(m[1].toLowerCase()) + 1}-${Number(m[2])}`;
    if (!okDates.has(key)) v('MSG_DATE', `The text mentions "${m[0]}", which is not part of any offer.`);
  }
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) if (!okDates.has(monthDay(m[0]))) v('MSG_DATE', `The text mentions ${m[0]}, which is not part of any offer.`);
  if (/https?:\/\/|www\./i.test(text)) v('MSG_LINK', 'The message contains a link; only the app may add the buyer link.');
  return { ok: violations.length === 0, violations };
}
