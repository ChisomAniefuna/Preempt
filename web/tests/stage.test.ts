import { describe, expect, it } from 'vitest';
import { latestOffer, optionLabel, progressIndex, sortInbox, stateMeta } from '../lib/stage';
import { parseUsdToCents, timeAgo, usd } from '../lib/format';
import type { Incident, Offer } from '../lib/types';

const inc = (over: Partial<Incident>): Incident => ({ id: 'x', order_id: 'o', rule_fired: 'NO_SCAN', risk_level: 'LOW', ai_reason: null, state: 'OPEN', dispute_id: null, opened_at: '2026-11-01T00:00:00Z', closed_at: null, orders: {} as never, ...over });
const offer = (over: Partial<Offer>): Offer => ({ id: 'f', incident_id: 'x', options: [], message: '', validator_result: { ok: true, violations: [] }, buyer_choice: null, buyer_reply: null, status: 'SENT', expires_at: null, created_at: '2026-11-01T00:00:00Z', ...over });

describe('inbox ordering', () => {
  it('puts rows that need the merchant first, then risk, then newest', () => {
    const rows = sortInbox([
      inc({ id: 'low-open', risk_level: 'LOW', state: 'OFFERED' }),
      inc({ id: 'high-open', risk_level: 'HIGH', state: 'OFFERED' }),
      inc({ id: 'low-approve', risk_level: 'LOW', state: 'AWAITING_APPROVAL' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['low-approve', 'high-open', 'low-open']);
  });
});

describe('progress', () => {
  it('walks the happy path', () => {
    expect(progressIndex('OPEN', null)).toBe(0);
    expect(progressIndex('OFFERED', offer({}))).toBe(1);
    expect(progressIndex('AWAITING_APPROVAL', offer({ status: 'CHOSEN' }))).toBe(2);
    expect(progressIndex('EXECUTING', offer({ status: 'APPROVED' }))).toBe(3);
    expect(progressIndex('RESOLVED', offer({ status: 'APPROVED' }))).toBe(4);
  });
  it('flags exits as needing action', () => {
    for (const s of ['AWAITING_APPROVAL', 'NEEDS_MERCHANT', 'DISPUTED', 'ACTION_FAILED']) expect(stateMeta(s).needsAction).toBe(true);
    expect(stateMeta('RESOLVED').needsAction).toBe(false);
  });
});

describe('helpers', () => {
  it('picks the newest offer', () => {
    expect(latestOffer([offer({ id: 'a', created_at: '2026-11-01T00:00:00Z' }), offer({ id: 'b', created_at: '2026-11-02T00:00:00Z' })])?.id).toBe('b');
    expect(latestOffer([])).toBeNull();
  });
  it('labels options', () => {
    expect(optionLabel({ type: 'PARTIAL_REFUND', amount_cents: 450 })).toBe('Partial refund $4.50');
    expect(optionLabel({ type: 'NEW_ETA', new_eta: '2026-11-20' })).toBe('New delivery date Nov 20, 2026');
  });
  it('formats money and parses input', () => {
    expect(usd(1500)).toBe('$15.00');
    expect(parseUsdToCents('$15.5')).toBe(1550);
    expect(parseUsdToCents('abc')).toBeNull();
    expect(parseUsdToCents('-1')).toBeNull();
  });
  it('formats relative time', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(timeAgo('2026-11-10T11:30:00Z', now)).toBe('30 min ago');
    expect(timeAgo('2026-11-05T12:00:00Z', now)).toBe('5 days ago');
    expect(timeAgo(null, now)).toBe('never');
  });
});
