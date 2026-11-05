import { DATA_RULES, type Llm, PROMPT_VERSION, quoteBuyerText } from './llm.ts';
import { AssessOut } from './schemas.ts';
import { usd } from '../types.ts';

export interface AssessInput {
  rule: string; ruleDetail: string; orderValueCents: number; promisedBy: string;
  shipment: { carrier: string; lastStatus: string | null; lastScanAt: string | null; events: { status: string; location?: string; at?: string }[] };
  paypal: { orderStatus?: string; captureStatuses?: string[]; openDisputes: number };
  priorBuyerMessages: string[];
}

export async function assess(llm: Llm, i: AssessInput) {
  const system = `You assess shipment risk for a small online merchant before the buyer complains. ${DATA_RULES}
Return riskLevel (LOW, MEDIUM or HIGH), likelyIssue (a short phrase), reason (one or two plain sentences, max 280 characters, citing the concrete signals) and contactBuyer (false only if contacting the buyer would be wrong, for example a dispute is already open).`;
  const prompt = JSON.stringify({
    rule_fired: i.rule, rule_detail: i.ruleDetail, order_value: usd(i.orderValueCents), promised_by: i.promisedBy,
    shipment: i.shipment, paypal: i.paypal, prior_buyer_messages: i.priorBuyerMessages.map(quoteBuyerText),
  });
  const r = await llm.generate({ name: 'assess', schema: AssessOut, system, prompt, temperature: 0.1 });
  const object = { ...r.object, reason: r.object.reason.slice(0, 280) };
  if (i.paypal.openDisputes > 0) object.contactBuyer = false; // code overrides the model on a hard fact
  return { object, meta: { model: llm.model, promptVersion: PROMPT_VERSION, latencyMs: r.latencyMs } };
}
