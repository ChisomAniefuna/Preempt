import type { Incident, Offer, Option, Violation } from './types';
import { shortDate, usd } from './format';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';
export const STATE_META: Record<string, { label: string; tone: Tone; needsAction: boolean }> = {
  OPEN: { label: 'Drafting offer', tone: 'neutral', needsAction: false },
  OFFERED: { label: 'Waiting for buyer', tone: 'accent', needsAction: false },
  AWAITING_APPROVAL: { label: 'Needs your approval', tone: 'warn', needsAction: true },
  EXECUTING: { label: 'Executing', tone: 'accent', needsAction: false },
  RESOLVED: { label: 'Resolved', tone: 'ok', needsAction: false },
  NEEDS_MERCHANT: { label: 'Needs you', tone: 'warn', needsAction: true },
  EXPIRED: { label: 'Expired', tone: 'neutral', needsAction: false },
  DISPUTED: { label: 'Dispute opened', tone: 'bad', needsAction: true },
  ACTION_FAILED: { label: 'Action failed', tone: 'bad', needsAction: true },
};
export const stateMeta = (state: string) => STATE_META[state] ?? { label: state, tone: 'neutral' as Tone, needsAction: false };

export const RULE_LABEL: Record<string, string> = {
  NO_SCAN: 'No carrier scan', DELAYED: 'Delivery delayed', FAILED: 'Delivery failed',
  RETURNED: 'Returned to sender', PAST_PROMISE: 'Promised date passed',
};

export const latestOffer = (offers: Offer[] | undefined): Offer | null =>
  offers && offers.length ? [...offers].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : null;

const RISK_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
// Rows that need the merchant first, then by risk, then newest.
export function sortInbox(rows: Incident[]): Incident[] {
  return [...rows].sort(
    (a, b) =>
      Number(stateMeta(b.state).needsAction) - Number(stateMeta(a.state).needsAction) ||
      (RISK_RANK[a.risk_level ?? ''] ?? 3) - (RISK_RANK[b.risk_level ?? ''] ?? 3) ||
      b.opened_at.localeCompare(a.opened_at),
  );
}

export function optionLabel(o: Option): string {
  switch (o.type) {
    case 'NEW_ETA': return `New delivery date ${o.new_eta ? shortDate(o.new_eta) : ''}`.trim();
    case 'RESHIP': return 'Reship with new tracking';
    case 'PARTIAL_REFUND': return `Partial refund ${usd(o.amount_cents)}`;
    case 'FULL_REFUND': return `Full refund ${usd(o.amount_cents)}`;
  }
}

export const violationText = (v: Violation | string) => (typeof v === 'string' ? v : v.message);

export const STEPS = ['Flagged', 'Offered', 'Buyer chose', 'Approved', 'Executed'] as const;
// How far along the happy path an incident is (index into STEPS, -1 if nothing yet).
export function progressIndex(state: string, offer: Offer | null): number {
  if (state === 'RESOLVED') return 4;
  if (state === 'EXECUTING' || state === 'ACTION_FAILED') return 3;
  if (offer?.status === 'APPROVED') return 3;
  if (state === 'AWAITING_APPROVAL' || offer?.status === 'CHOSEN') return 2;
  if (state === 'OFFERED' || offer?.status === 'SENT') return 1;
  return 0;
}

export const lastScanAt = (inc: Incident): string | null =>
  (inc.orders.shipments ?? []).map((s) => s.last_scan_at).filter((x): x is string => !!x).sort().at(-1) ?? null;
