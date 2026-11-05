export type Remedy = 'NEW_ETA' | 'RESHIP' | 'PARTIAL_REFUND' | 'FULL_REFUND';
export const REMEDIES: Remedy[] = ['NEW_ETA', 'RESHIP', 'PARTIAL_REFUND', 'FULL_REFUND'];

export interface Option {
  type: Remedy;
  amount_cents?: number;
  new_eta?: string; // YYYY-MM-DD
  rationale?: string;
}

export interface Policy {
  merchant_id: string;
  allowed_remedies: Remedy[];
  max_refund_percent: number;
  max_refund_cents: number;
  auto_approve_cents: number;
  no_scan_days: number;
  tone: string;
}

export interface OrderFacts {
  amount_cents: number;
  refunded_cents: number;
  promised_by: string; // ISO timestamp
}

export interface Violation { code: string; message: string; index?: number }
export interface ValidatorResult { ok: boolean; violations: Violation[] }

export type RiskRule = 'NO_SCAN' | 'DELAYED' | 'FAILED' | 'RETURNED' | 'PAST_PROMISE';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
