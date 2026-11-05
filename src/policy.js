import { q } from './db.js';
import { addDays, ymd } from './clock.js';

export const REMEDIES = ['new_eta', 'reship', 'partial_refund', 'full_refund'];

export const DEFAULT_POLICY = {
  allowedRemedies: ['new_eta', 'reship', 'partial_refund'],
  refundCapPercent: 20,
  refundCapCents: 2000,
  autoApproveCents: 500,
  maxEtaDays: 14,
  tone: 'friendly',
};

export function loadPolicy(db) {
  const row = q.get(db, 'SELECT json FROM policy WHERE id = 1');
  return row ? { ...DEFAULT_POLICY, ...JSON.parse(row.json) } : { ...DEFAULT_POLICY };
}

export function savePolicy(db, input) {
  const p = {
    allowedRemedies: (input.allowedRemedies || []).filter((r) => REMEDIES.includes(r)),
    refundCapPercent: clampNum(input.refundCapPercent, 0, 100),
    refundCapCents: Math.max(0, Math.round(Number(input.refundCapCents) || 0)),
    autoApproveCents: Math.max(0, Math.round(Number(input.autoApproveCents) || 0)),
    maxEtaDays: clampNum(input.maxEtaDays, 1, 60),
    tone: ['friendly', 'formal', 'concise'].includes(input.tone) ? input.tone : 'friendly',
  };
  q.run(db, 'INSERT INTO policy (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', JSON.stringify(p));
  return p;
}

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

export const refundedSoFar = (db, captureId) =>
  q.get(db, 'SELECT COALESCE(SUM(amount_cents), 0) AS s FROM refunds WHERE capture_id = ?', captureId).s;

// Hard cap for a partial refund: percent of the order, dollar cap, and what is left on the capture.
export function maxPartialRefundCents(policy, order, alreadyRefunded) {
  const byPercent = Math.floor((order.amount_cents * policy.refundCapPercent) / 100);
  return Math.max(0, Math.min(byPercent, policy.refundCapCents, order.amount_cents - alreadyRefunded));
}

/**
 * The validator. Everything the model proposes passes through here; nothing else decides money.
 * Returns the offers that are within policy plus a violation for each one that is not.
 */
export function validateOffers(offers, { policy, order, refunded = 0, now }) {
  const violations = [];
  const accepted = [];
  const seen = new Set();
  const list = Array.isArray(offers) ? offers : [];

  if (list.length === 0) violations.push({ index: -1, code: 'no_offers', message: 'No remedies proposed.' });
  if (list.length > 3) violations.push({ index: -1, code: 'too_many', message: 'More than three remedies proposed.' });

  list.slice(0, 3).forEach((o, index) => {
    const bad = (code, message) => violations.push({ index, code, message, offer: o });
    if (!o || typeof o !== 'object') return bad('malformed', 'Offer is not an object.');
    if (!REMEDIES.includes(o.type)) return bad('unknown_type', `Unknown remedy "${o.type}".`);
    if (!policy.allowedRemedies.includes(o.type)) return bad('not_allowed', `Remedy "${o.type}" is not on the merchant's allowed list.`);
    if (seen.has(o.type)) return bad('duplicate', `Remedy "${o.type}" offered twice.`);

    if (o.type === 'partial_refund') {
      const cap = maxPartialRefundCents(policy, order, refunded);
      if (!Number.isInteger(o.amountCents) || o.amountCents <= 0) return bad('bad_amount', 'Refund amount must be a positive whole number of cents.');
      if (o.amountCents > cap) return bad('over_cap', `Refund of ${fmt(o.amountCents)} exceeds the cap of ${fmt(cap)}.`);
    }
    if (o.type === 'full_refund') {
      const left = order.amount_cents - refunded;
      if (left <= 0) return bad('nothing_to_refund', 'The capture is already fully refunded.');
      if (o.amountCents !== left) return bad('bad_amount', `A full refund must equal the remaining ${fmt(left)}.`);
    }
    if (o.type === 'new_eta') {
      const t = Date.parse(o.eta);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.eta || '') || Number.isNaN(t)) return bad('bad_eta', 'ETA must be a YYYY-MM-DD date.');
      if (o.eta <= ymd(now)) return bad('eta_in_past', 'ETA must be in the future.');
      if (o.eta > ymd(addDays(now, policy.maxEtaDays))) return bad('eta_too_far', `ETA is more than ${policy.maxEtaDays} days out.`);
    }
    seen.add(o.type);
    accepted.push(o);
  });

  return { ok: violations.length === 0 && accepted.length > 0, accepted, violations };
}

export const fmt = (cents) => `$${(cents / 100).toFixed(2)}`;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const humanDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${d}, ${y}`;
};

/**
 * Checks that every dollar amount and date in outgoing text matches the approved offers
 * (or the order's own facts). Catches a model that "improves" the numbers while writing.
 */
export function validateMessage(text, offers, order) {
  const problems = [];
  const okAmounts = new Set([order.amount_cents, ...offers.filter((o) => o.amountCents).map((o) => o.amountCents)]);
  for (const m of text.matchAll(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)) {
    const cents = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
    if (!okAmounts.has(cents)) problems.push(`amount ${m[0]} is not part of any offer`);
  }
  const okDates = new Set([order.promised_date, ...offers.filter((o) => o.eta).map((o) => o.eta)].map(humanDate));
  const dateRe = new RegExp(`\\b(${MONTHS.map((m) => m[0].toUpperCase() + m.slice(1)).join('|')})[a-z]*\\.? \\d{1,2}(?:, \\d{4})?`, 'g');
  for (const m of text.matchAll(dateRe)) {
    const norm = normaliseDate(m[0]);
    if (norm && ![...okDates].some((d) => d.startsWith(norm))) problems.push(`date "${m[0]}" is not part of any offer`);
  }
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    if (!okDates.has(humanDate(m[0]))) problems.push(`date ${m[0]} is not part of any offer`);
  }
  return { ok: problems.length === 0, problems };
}

function normaliseDate(s) {
  const m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2})/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${Number(m[2])}` : null;
}
