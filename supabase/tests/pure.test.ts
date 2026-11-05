import { assert, assertEquals } from 'jsr:@std/assert@1';
import { maxRefundCents, validateChoice, validateMessage, validateOptions } from '../functions/_shared/validator.ts';
import { evaluateRules } from '../functions/_shared/risk-rules.ts';
import { eventsUpTo } from '../functions/_shared/carrier-sim.ts';
import { hashToken, signToken, verifyToken } from '../functions/_shared/buyer-token.ts';
import type { Policy } from '../functions/_shared/types.ts';

const now = new Date('2026-11-10T12:00:00Z');
const policy: Policy = { merchant_id: 'm', allowed_remedies: ['NEW_ETA', 'RESHIP', 'PARTIAL_REFUND'], max_refund_percent: 20, max_refund_cents: 1500, auto_approve_cents: 500, no_scan_days: 3, tone: 'warm' };
const order = { amount_cents: 4800, refunded_cents: 0, promised_by: '2026-11-09T00:00:00Z' };
const ctx = { policy, order, now };

Deno.test('refund cap is the lowest of dollars, percent and remaining capture', () => {
  assertEquals(maxRefundCents(policy, order), 960); // 20% of $48
  assertEquals(maxRefundCents(policy, { ...order, amount_cents: 9600 }), 1500); // dollar cap bites
  assertEquals(maxRefundCents(policy, { ...order, refunded_cents: 4700 }), 100); // only $1 left
});
Deno.test('amount exactly at the cap passes, one cent over is blocked', () => {
  assert(validateOptions([{ type: 'PARTIAL_REFUND', amount_cents: 960 }], ctx).ok);
  const r = validateOptions([{ type: 'PARTIAL_REFUND', amount_cents: 961 }], ctx);
  assertEquals(r.violations[0].code, 'OVER_CAP');
});
Deno.test('remedy not on the allowed list is blocked', () => {
  assertEquals(validateOptions([{ type: 'FULL_REFUND', amount_cents: 4800 }], ctx).violations[0].code, 'NOT_ALLOWED');
});
Deno.test('only one refund option per offer, no duplicates, max three', () => {
  const p = { ...policy, allowed_remedies: ['NEW_ETA', 'RESHIP', 'PARTIAL_REFUND', 'FULL_REFUND'] as Policy['allowed_remedies'] };
  assertEquals(validateOptions([{ type: 'PARTIAL_REFUND', amount_cents: 100 }, { type: 'FULL_REFUND', amount_cents: 4800 }], { ...ctx, policy: p }).violations[0].code, 'ONE_REFUND_ONLY');
  assertEquals(validateOptions([{ type: 'RESHIP' }, { type: 'RESHIP' }], ctx).violations[0].code, 'DUPLICATE');
  assertEquals(validateOptions([{ type: 'RESHIP' }, { type: 'NEW_ETA', new_eta: '2026-11-15' }, { type: 'PARTIAL_REFUND', amount_cents: 100 }, { type: 'RESHIP' }], ctx).violations[0].code, 'TOO_MANY');
});
Deno.test('ETA must be after today and within 30 days', () => {
  assertEquals(validateOptions([{ type: 'NEW_ETA', new_eta: '2026-11-10' }], ctx).violations[0].code, 'ETA_IN_PAST');
  assertEquals(validateOptions([{ type: 'NEW_ETA', new_eta: '2026-12-11' }], ctx).violations[0].code, 'ETA_TOO_FAR');
  assert(validateOptions([{ type: 'NEW_ETA', new_eta: '2026-12-10' }], ctx).ok);
});
Deno.test('an open dispute blocks every offer', () => {
  assertEquals(validateOptions([{ type: 'RESHIP' }], { ...ctx, disputeOpen: true }).violations[0].code, 'DISPUTE_OPEN');
});
Deno.test('choice re-check uses the refunded total at execution time', () => {
  const opt = { type: 'PARTIAL_REFUND' as const, amount_cents: 900 };
  assert(validateChoice(opt, ctx).ok);
  assertEquals(validateChoice(opt, { ...ctx, order: { ...order, refunded_cents: 4000 } }).violations[0].code, 'OVER_CAP');
});

const msg = (body: string, amounts: number[] = [], dates: string[] = []) => ({ subject: 'Your order', body, mentionedAmountsCents: amounts, mentionedDates: dates });
const opts = [{ type: 'PARTIAL_REFUND' as const, amount_cents: 450 }, { type: 'NEW_ETA' as const, new_eta: '2026-11-15' }];
Deno.test('message amounts and dates must match the offer', () => {
  assert(validateMessage(msg('We can refund $4.50 or deliver by Nov 15.', [450], ['2026-11-15']), opts, order).ok);
  assert(!validateMessage(msg('We can refund $20.00.'), opts, order).ok);
  assert(!validateMessage(msg('Delivery by November 20.'), opts, order).ok);
  assert(!validateMessage(msg('ok', [999]), opts, order).ok);
  assert(!validateMessage(msg('ok', [], ['2026-11-20']), opts, order).ok);
});
Deno.test('message may not contain links', () => {
  assertEquals(validateMessage(msg('Click https://evil.example now'), opts, order).violations[0].code, 'MSG_LINK');
});

Deno.test('each risk rule fires on its fixture and on nothing else', () => {
  const base = { lastStatus: 'IN_TRANSIT', lastScanAt: '2026-11-10T08:00:00Z', shippedAt: '2026-11-08T00:00:00Z', promisedBy: '2026-11-15T00:00:00Z' };
  const rules = (o: Partial<typeof base>) => evaluateRules({ ...base, ...o }, now, 3).map((h) => h.rule);
  assertEquals(rules({}), []);
  assertEquals(rules({ lastScanAt: '2026-11-05T00:00:00Z' }), ['NO_SCAN']);
  assertEquals(rules({ lastStatus: 'DELAYED' }), ['DELAYED']);
  assertEquals(rules({ lastStatus: 'DELIVERY_FAILED' }), ['FAILED']);
  assertEquals(rules({ lastStatus: 'RETURNED' }), ['RETURNED']);
  assertEquals(rules({ promisedBy: '2026-11-09T00:00:00Z' }), ['PAST_PROMISE']);
  assertEquals(rules({ lastStatus: 'DELIVERED', promisedBy: '2026-11-01T00:00:00Z' }), []);
});
Deno.test('no scans at all measures from the ship date', () => {
  assertEquals(evaluateRules({ lastStatus: null, lastScanAt: null, shippedAt: '2026-11-05T00:00:00Z', promisedBy: '2026-11-20T00:00:00Z' }, now, 3).map((h) => h.rule), ['NO_SCAN']);
});

Deno.test('stall scenario stops after day 2; failed shows DELIVERY_FAILED on day 4', () => {
  const start = '2026-11-01T00:00:00Z';
  const at = (d: number) => new Date(Date.parse(start) + d * 86_400_000 + 1000);
  assertEquals(eventsUpTo('stall', 'T1', start, at(30)).at(-1)?.status, 'IN_TRANSIT');
  assertEquals(eventsUpTo('stall', 'T1', start, at(30)).length, 3);
  assertEquals(eventsUpTo('failed', 'T1', start, at(3)).at(-1)?.status, 'IN_TRANSIT');
  assertEquals(eventsUpTo('failed', 'T1', start, at(4)).at(-1)?.status, 'DELIVERY_FAILED');
  assertEquals(eventsUpTo('on_time', 'T1', start, at(5)).at(-1)?.status, 'DELIVERED');
});

Deno.test('buyer tokens: sign, verify, tamper, wrong secret', async () => {
  const t = await signToken('offer-1', 123456, 'secret');
  assertEquals(await verifyToken(t, 'secret'), { ok: true, offerId: 'offer-1', expiresAtMs: 123456 });
  assertEquals((await verifyToken(t, 'other')).ok, false);
  const [p, s] = t.split('.');
  const forged = btoa('offer-2.123456').replace(/=+$/, '');
  assertEquals((await verifyToken(`${forged}.${s}`, 'secret')).ok, false);
  assertEquals((await verifyToken('garbage', 'secret')).ok, false);
  assert(p.length > 0);
  assertEquals((await hashToken(t)).length, 64);
});
