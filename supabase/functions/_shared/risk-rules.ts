import type { RiskRule } from './types.ts';

export interface ShipmentFacts {
  lastStatus: string | null;
  lastScanAt: string | null;
  shippedAt: string; // when the label/tracking was created
  promisedBy: string;
}
export interface RuleHit { rule: RiskRule; detail: string }

const PRIORITY: RiskRule[] = ['RETURNED', 'FAILED', 'DELAYED', 'PAST_PROMISE', 'NO_SCAN'];
export const TERMINAL = ['DELIVERED', 'RETURNED'];

/** Deterministic candidate-risk rules. No model decides whether an order is a candidate. */
export function evaluateRules(s: ShipmentFacts, now: Date, noScanDays: number): RuleHit[] {
  const hits: RuleHit[] = [];
  if (s.lastStatus === 'DELIVERED') return hits;
  if (s.lastStatus === 'RETURNED') hits.push({ rule: 'RETURNED', detail: 'The carrier returned the parcel to the sender.' });
  if (s.lastStatus === 'DELIVERY_FAILED') hits.push({ rule: 'FAILED', detail: 'The carrier could not deliver the parcel.' });
  if (s.lastStatus === 'DELAYED') hits.push({ rule: 'DELAYED', detail: 'The carrier reported a delay.' });
  if (s.lastStatus !== 'RETURNED' && now.getTime() > Date.parse(s.promisedBy)) {
    hits.push({ rule: 'PAST_PROMISE', detail: `The promised date (${s.promisedBy.slice(0, 10)}) has passed without delivery.` });
  }
  if (s.lastStatus !== 'RETURNED') {
    const idleDays = (now.getTime() - Date.parse(s.lastScanAt ?? s.shippedAt)) / 86_400_000;
    if (idleDays >= noScanDays) hits.push({ rule: 'NO_SCAN', detail: `No carrier scan for ${Math.floor(idleDays)} days (threshold ${noScanDays}).` });
  }
  return hits.sort((a, b) => PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule));
}
