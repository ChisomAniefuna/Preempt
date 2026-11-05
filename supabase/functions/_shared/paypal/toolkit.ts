// The agent's PayPal access: read-only lookups. There is deliberately no refund, create-order or
// invoice function here, and the agent is never handed the full client. The PRD's preferred
// @paypal/agent-toolkit could not be verified under Deno, so these three tools are hand-written
// on the REST client (the PRD's documented fallback).
import type { PayPal } from './client.ts';

export interface ReadTools {
  get_order(orderId: string): Promise<{ id: string; status: string; captures: { id: string; status: string; amount: string }[] }>;
  get_shipment_facts(captureId: string): Promise<{ openDisputes: { dispute_id: string; status: string }[] }>;
}

export function createReadTools(pp: Pick<PayPal, 'getOrder' | 'listDisputes'>): ReadTools {
  return {
    async get_order(orderId) {
      const o = await pp.getOrder(orderId);
      const captures = (o.purchase_units ?? []).flatMap((u) => u.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status, amount: `${c.amount.value} ${c.amount.currency_code}` }));
      return { id: o.id, status: o.status, captures };
    },
    async get_shipment_facts(captureId) {
      const d = await pp.listDisputes(captureId);
      return { openDisputes: (d.items ?? []).filter((x) => x.status !== 'RESOLVED') };
    },
  };
}
