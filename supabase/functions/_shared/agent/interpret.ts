import { DATA_RULES, type Llm, PROMPT_VERSION, quoteBuyerText } from './llm.ts';
import { InterpretOut } from './schemas.ts';
import { type Option, usd } from '../types.ts';

/**
 * Reads a buyer's free-text reply. No tools, and the output can only pick one of the existing options
 * (or nothing): it can never add a remedy or change an amount.
 */
export async function interpret(llm: Llm, a: { reply: string; options: Option[] }) {
  const system = `You read a buyer's reply to a remedy offer. ${DATA_RULES}
Return choice = the zero-based index of the offered option the buyer clearly accepted, or null if they did not clearly accept exactly one. Return wantsMore = true if they ask for more than offered (for example a full refund or a bigger amount). Also return sentiment (CALM, UPSET or ANGRY) and a one-sentence neutral summary.`;
  const prompt = JSON.stringify({
    offered_options: a.options.map((o, index) => ({ index, type: o.type, amount: o.amount_cents != null ? usd(o.amount_cents) : undefined, new_eta: o.new_eta })),
    reply: quoteBuyerText(a.reply),
  });
  const r = await llm.generate({ name: 'interpret', schema: InterpretOut, system, prompt, temperature: 0 });
  const valid = r.object.choice !== null && r.object.choice >= 0 && r.object.choice < a.options.length;
  const object = { ...r.object, choice: valid ? r.object.choice : null };
  if (object.wantsMore) object.choice = null; // asking for more is never an acceptance
  return { object, meta: { model: llm.model, promptVersion: PROMPT_VERSION, latencyMs: r.latencyMs } };
}
