import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, validateOffers, validateMessage, maxPartialRefundCents } from '../src/policy.js';

const now = new Date('2026-11-10T12:00:00Z');
const order = { amount_cents: 6000, promised_date: '2026-11-12' };
const v = (offers, over = {}) => validateOffers(offers, { policy: { ...DEFAULT_POLICY, ...over }, order, refunded: 0, now });

test('cap is min of percent, dollars and remaining capture', () => {
  assert.equal(maxPartialRefundCents(DEFAULT_POLICY, order, 0), 1200);
  assert.equal(maxPartialRefundCents({ ...DEFAULT_POLICY, refundCapCents: 500 }, order, 0), 500);
  assert.equal(maxPartialRefundCents(DEFAULT_POLICY, order, 5900), 100);
});
test('over-cap refund is blocked', () => {
  const r = v([{ type: 'partial_refund', amountCents: 3000 }]);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].code, 'over_cap');
});
test('full refund blocked unless allowed', () => assert.equal(v([{ type: 'full_refund', amountCents: 6000 }]).violations[0].code, 'not_allowed'));
test('within-policy offers pass', () => assert.equal(v([{ type: 'reship' }, { type: 'partial_refund', amountCents: 600 }, { type: 'new_eta', eta: '2026-11-15' }]).ok, true));
test('more than three offers is rejected', () => assert.equal(v([{ type: 'reship' }, { type: 'new_eta', eta: '2026-11-15' }, { type: 'partial_refund', amountCents: 100 }, { type: 'partial_refund', amountCents: 200 }]).ok, false));
test('past or too-distant ETA is rejected', () => {
  assert.equal(v([{ type: 'new_eta', eta: '2026-11-09' }]).ok, false);
  assert.equal(v([{ type: 'new_eta', eta: '2027-03-01' }]).ok, false);
});
test('message amounts and dates must match offers', () => {
  const offers = [{ type: 'partial_refund', amountCents: 600 }, { type: 'new_eta', eta: '2026-11-15' }];
  assert.equal(validateMessage('We offer $6.00 back or delivery by Nov 15, 2026.', offers, order).ok, true);
  assert.equal(validateMessage('We offer $20.00 back.', offers, order).ok, false);
  assert.equal(validateMessage('Delivery by Nov 20.', offers, order).ok, false);
});
