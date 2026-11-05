import { DATA_RULES, type Llm, PROMPT_VERSION } from './llm.ts';
import { MessageOut } from './schemas.ts';
import { type Option, usd } from '../types.ts';

export interface MessageInput {
  options: Option[]; tone: string; buyerName: string; buyerLocale: string; merchantName: string; merchantOrderId: string; promisedBy: string; violations: string[];
}

export async function draftMessage(llm: Llm, i: MessageInput) {
  const system = `You write a short, human email from a small merchant to a buyer whose order is running late or has failed. ${DATA_RULES}
Tone: ${i.tone}. Write in the buyer's language (locale ${i.buyerLocale}). Apologise once, explain plainly, and list the options exactly as given.
Use only the amounts and dates in the options (and the original promised date). List every dollar amount in mentionedAmountsCents (integer cents) and every date in mentionedDates (YYYY-MM-DD). Do NOT include any links or URLs: the app adds the buyer link. Do not promise anything beyond the options.
If previous_problems is not empty, your last draft had these problems: fix them.`;
  const prompt = JSON.stringify({
    buyer_name: i.buyerName, merchant: i.merchantName, order: i.merchantOrderId, originally_promised: i.promisedBy.slice(0, 10),
    options: i.options.map((o) => ({ ...o, display_amount: o.amount_cents != null ? usd(o.amount_cents) : undefined })),
    previous_problems: i.violations,
  });
  const r = await llm.generate({ name: 'message', schema: MessageOut, system, prompt, temperature: 0.5 });
  return { object: r.object, meta: { model: llm.model, promptVersion: PROMPT_VERSION, latencyMs: r.latencyMs } };
}

/** Deterministic message built only from the approved options. Used when the model's drafts keep failing validation. */
export function templateMessage(i: Pick<MessageInput, 'options' | 'buyerName' | 'merchantName' | 'merchantOrderId'>) {
  const lines = i.options.map((o) => {
    if (o.type === 'NEW_ETA') return `- A new delivery date of ${o.new_eta}`;
    if (o.type === 'RESHIP') return '- We send a replacement with new tracking';
    return `- A ${o.type === 'FULL_REFUND' ? 'full' : 'partial'} refund of ${usd(o.amount_cents!)} to your PayPal account`;
  });
  return {
    subject: `An update on your order ${i.merchantOrderId}`,
    body: `Hi ${i.buyerName},\n\nWe are sorry: your order ${i.merchantOrderId} has run into a delivery problem. Here is how we can make it right:\n${lines.join('\n')}\n\nPlease choose one with the button below and we will take care of it.\n\n${i.merchantName}`,
    mentionedAmountsCents: i.options.filter((o) => o.amount_cents != null).map((o) => o.amount_cents as number),
    mentionedDates: i.options.filter((o) => o.new_eta).map((o) => o.new_eta as string),
  };
}
