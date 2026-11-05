// Local stand-in for the Anthropic Messages API. Answers the four agent steps with canned structured output.
// The first propose call of each incident is deliberately over-reaching, to exercise the validator's block-and-retry.
import { createServer } from 'node:http';
const seenPropose = new Set();
const ymd = (d) => d.toISOString().slice(0, 10);
const answer = (system, prompt) => {
  const P = JSON.parse(prompt);
  if (system.includes('assess shipment risk')) return { riskLevel: P.rule_fired === 'FAILED' ? 'HIGH' : 'MEDIUM', likelyIssue: 'Parcel stuck', reason: `Rule ${P.rule_fired} fired on a ${P.order_value} order; last status ${P.shipment.lastStatus ?? 'none'}.`, contactBuyer: true };
  if (system.includes('choose one to three remedies')) {
    const cap = Number(system.match(/may not exceed \$([\d.]+)/)[1]); const key = P.order_value + P.assessment.reason;
    if (!seenPropose.has(key) && P.previous_violations.length === 0) { seenPropose.add(key); return { options: [{ type: 'PARTIAL_REFUND', amountCents: Math.round(Number(P.order_value.slice(1)) * 100), rationale: 'Refund everything to keep them happy.' }] }; }
    const eta = ymd(new Date(Date.now() + 4 * 86400000));
    return { options: [{ type: 'NEW_ETA', newEta: eta, rationale: 'We will chase the carrier.' }, { type: 'PARTIAL_REFUND', amountCents: Math.min(Math.round(cap * 100), 900), rationale: 'A goodwill refund for the delay.' }, { type: 'RESHIP', rationale: 'A replacement is on us.' }] };
  }
  if (system.includes('write a short, human email')) {
    const lines = P.options.map((o) => o.type === 'NEW_ETA' ? `- A new delivery date of ${new Date(o.new_eta + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}` : o.type === 'RESHIP' ? '- A replacement shipped to you' : `- A refund of ${o.display_amount}`);
    return { subject: `About your order ${P.order}`, body: `Hi ${P.buyer_name},\n\nSorry, your order ${P.order} ran into a delivery problem. Options:\n${lines.join('\n')}\n\nThanks for your patience.`, mentionedAmountsCents: P.options.filter((o) => o.amount_cents).map((o) => o.amount_cents), mentionedDates: P.options.filter((o) => o.new_eta).map((o) => o.new_eta) };
  }
  if (system.includes("read a buyer's reply")) {
    const t = P.reply.toLowerCase(); const more = /full refund|refund me \$|everything|all my money/.test(t);
    const idx = P.offered_options.findIndex((o) => (/refund/.test(t) && o.type === 'PARTIAL_REFUND') || (/wait|date|eta/.test(t) && o.type === 'NEW_ETA') || (/reship|replacement/.test(t) && o.type === 'RESHIP'));
    return { choice: more || idx < 0 ? null : idx, wantsMore: more, sentiment: more ? 'ANGRY' : 'CALM', summary: 'Mock summary.' };
  }
  throw new Error('unknown step');
};
createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const j = JSON.parse(body); const system = typeof j.system === 'string' ? j.system : (j.system ?? []).map((s) => s.text).join('\n');
      const prompt = j.messages.at(-1).content; const text = typeof prompt === 'string' ? prompt : prompt.map((c) => c.text).join('');
      const input = answer(system, text); const tool = j.tools?.[0]?.name ?? 'json';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'tool_use', id: 'toolu_mock', name: tool, input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
    } catch (e) { console.error('mock llm error', e.message, body.slice(0, 300)); res.writeHead(500); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e.message) } })); }
  });
}).listen(4020, '::', () => console.log('llm mock on 4020'));
