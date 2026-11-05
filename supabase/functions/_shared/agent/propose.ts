import { DATA_RULES, type Llm, PROMPT_VERSION } from './llm.ts';
import { ProposeOut } from './schemas.ts';
import type { Option, Policy, Violation } from '../types.ts';
import { usd } from '../types.ts';
import { maxRefundCents } from '../validator.ts';

export interface ProposeInput {
  policy: Policy; order: { amount_cents: number; refunded_cents: number }; assessment: { riskLevel: string; likelyIssue: string; reason: string };
  todayYmd: string; violations: Violation[]; rejected: { options: Option[]; note?: string }[];
}

export async function propose(llm: Llm, i: ProposeInput) {
  const cap = maxRefundCents(i.policy, i.order);
  const system = `You choose one to three remedies to offer a buyer whose order is at risk. ${DATA_RULES}
Choose ONLY from these allowed remedies: ${i.policy.allowed_remedies.join(', ')}.
Prefer the least costly fix that is fair. Offer at most one refund option. A partial refund may not exceed ${usd(cap)} (a hard limit enforced in code; your number is only a proposal). A new delivery date (newEta, YYYY-MM-DD) must be after ${i.todayYmd} and within 30 days. For refunds set amountCents as a whole number of cents. Each option needs a one-sentence rationale.
If previous_violations is not empty, your last proposal broke these rules: fix them. If rejected_by_merchant is not empty, do not repeat those options.`;
  const prompt = JSON.stringify({
    assessment: i.assessment, order_value: usd(i.order.amount_cents), already_refunded: usd(i.order.refunded_cents), tone: i.policy.tone,
    previous_violations: i.violations.map((v) => v.message), rejected_by_merchant: i.rejected,
  });
  const r = await llm.generate({ name: 'propose', schema: ProposeOut, system, prompt, temperature: 0.2 });
  const options: Option[] = r.object.options.map((o) => ({
    type: o.type,
    ...(o.amountCents != null ? { amount_cents: o.amountCents } : {}),
    ...(o.newEta ? { new_eta: o.newEta } : {}),
    rationale: o.rationale,
  }));
  return { options, meta: { model: llm.model, promptVersion: PROMPT_VERSION, latencyMs: r.latencyMs } };
}
