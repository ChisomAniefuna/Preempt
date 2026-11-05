export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Remedy = 'NEW_ETA' | 'RESHIP' | 'PARTIAL_REFUND' | 'FULL_REFUND';
export const REMEDIES: Remedy[] = ['NEW_ETA', 'RESHIP', 'PARTIAL_REFUND', 'FULL_REFUND'];

export interface Option {
  type: Remedy;
  amount_cents?: number;
  new_eta?: string;
  rationale?: string;
}

export interface Violation { code?: string; message: string }
export interface ValidatorResult { ok: boolean; violations: (Violation | string)[] }

export interface Shipment {
  id: string; order_id: string; carrier: string; tracking_number: string;
  paypal_tracker_id: string | null; last_status: string | null; last_scan_at: string | null;
  events: { day?: number; status: string; location?: string; at?: string }[];
}

export interface Order {
  id: string; merchant_order_id: string; paypal_order_id: string; capture_id: string;
  amount_cents: number; currency: string; refunded_cents: number;
  buyer_email: string; buyer_name: string; promised_by: string; shipments?: Shipment[];
}

export interface Action {
  id: string; offer_id: string; type: 'REFUND' | 'RESHIP' | 'NEW_ETA'; amount_cents: number | null;
  idempotency_key: string; paypal_ref_id: string | null; status: 'PENDING' | 'COMPLETED' | 'FAILED';
  error: { message?: string } | null; created_at: string;
}

export interface Offer {
  id: string; incident_id: string; options: Option[]; message: string; validator_result: ValidatorResult;
  buyer_choice: (Option & { index?: number }) | null; buyer_reply: string | null;
  status: 'DRAFT' | 'BLOCKED' | 'SENT' | 'CHOSEN' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  expires_at: string | null; created_at: string; actions?: Action[];
}

export interface Incident {
  id: string; order_id: string; rule_fired: string; risk_level: RiskLevel | null; ai_reason: string | null;
  state: string; dispute_id: string | null; opened_at: string; closed_at: string | null;
  orders: Order; offers?: Offer[];
}

export interface AuditEvent {
  id: number; incident_id: string; actor: string; kind: string;
  input: unknown; output: unknown; created_at: string;
}

export interface Policy {
  merchant_id: string; allowed_remedies: Remedy[]; max_refund_percent: number; max_refund_cents: number;
  auto_approve_cents: number; no_scan_days: number; tone: string;
}

export interface DashboardTotals {
  incidents_opened: number; resolved_without_dispute: number; refunds_issued_cents: number;
  refunds_count: number; disputes_opened: number; estimated_cost_avoided_cents: number;
}

// Contract with the `buyer` Edge Function (GET ?token=..., POST /choose).
export interface BuyerView {
  status: 'OPEN' | 'CHOSEN' | 'RESOLVED' | 'EXPIRED';
  merchant_name: string; buyer_name: string; merchant_order_id: string;
  message: string; options: Option[]; chosen?: Option | null; reply_ack?: string | null;
}
