import { fmt, humanDate, REMEDIES } from './policy.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14213d;--mute:#5b6577;--line:#e3e6ec;--accent:#0b5fff;--ok:#127a46;--warn:#a65b00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#171b22;--ink:#e8ecf3;--mute:#9aa4b5;--line:#2a313c;--accent:#6ea0ff;--ok:#4cc38a;--warn:#e0a24a;--bad:#ff7b72}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
header b{font-size:18px}header a{color:var(--mute);text-decoration:none}header a:hover{color:var(--accent)}
main{max-width:920px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
h1{font-size:22px;margin:8px 0 16px}h2{font-size:17px;margin:0 0 8px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:13px;border:1px solid var(--line);color:var(--mute)}
.high{color:var(--bad);border-color:var(--bad)}.medium{color:var(--warn);border-color:var(--warn)}.low{color:var(--ok);border-color:var(--ok)}
button,.btn{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--accent)}button.danger{background:transparent;color:var(--bad);border-color:var(--bad)}
input,select,textarea{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);max-width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat b{display:block;font-size:26px}.stat span{color:var(--mute);font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
pre{white-space:pre-wrap;margin:0;font:inherit}.mute{color:var(--mute)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.msg{border-left:3px solid var(--line);padding:4px 12px;margin:8px 0}
`;

export const page = (title, body, { nav = true } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
${nav ? `<header><b>Preempt</b><a href="/merchant">Inbox</a><a href="/dashboard">Dashboard</a><a href="/policy">Policy</a><a href="/dev">Simulator</a></header>` : ''}
<main>${body}</main></body></html>`;

export const offerText = (o) => (o.type === 'new_eta' ? `New ETA ${humanDate(o.eta)}` : o.type === 'reship' ? 'Reship with new tracking' : `${o.type === 'full_refund' ? 'Full' : 'Partial'} refund ${fmt(o.amountCents)}`);

export function buyerPage(inc, order, messages, offers) {
  const open = inc.state === 'offered';
  const msg = messages.filter((m) => m.direction === 'out').map((m) => `<div class="msg"><pre>${esc(m.body.replace(/\n\nhttps?:\S+$/, ''))}</pre></div>`).join('');
  const options = open
    ? offers.map((o, i) => `<form method="post"><input type="hidden" name="index" value="${i}"><button>${esc(offerText(o))}</button></form>`).join('')
    : `<p class="mute">${inc.state === 'offered' ? '' : 'Thanks, this has been taken care of.'}</p>`;
  const more = open ? `<form method="post" class="card"><h2>Something else?</h2><p class="mute">Tell us in your own words.</p><textarea name="text" rows="3" style="width:100%"></textarea><br><button class="ghost">Send</button></form>` : '';
  return page('Your order', `<h1>Order ${esc(order.merchant_order_id)}</h1><div class="card">${msg}<div class="row">${options}</div></div>${more}`, { nav: false });
}

export function inboxPage(rows, active) {
  const pending = rows.map((r) => `<div class="card"><div class="row"><b>${esc(r.order.merchant_order_id)}</b><span class="pill ${esc(r.inc.risk_level)}">${esc(r.inc.risk_level)}</span><span class="pill">${esc(r.inc.state)}</span><span class="mute">${esc(r.order.buyer_name)} · ${fmt(r.order.amount_cents)}</span></div>
<p>${esc(r.inc.issue)}: ${esc(r.inc.reason)}</p>
<p>${r.chosen ? `Buyer chose: <b>${esc(offerText(r.chosen))}</b>` : '<b>Buyer asked for more than your policy allows.</b> Decide below or change your policy.'}</p>
${decisionForm(r)}<p><a href="/merchant/incidents/${r.inc.id}">Full timeline</a></p></div>`).join('') || '<p class="mute">Nothing waiting for you.</p>';
  const list = active.map((r) => `<tr><td><a href="/merchant/incidents/${r.id}">#${r.id}</a></td><td>${esc(r.merchant_order_id)}</td><td>${esc(r.rule)}</td><td>${esc(r.risk_level)}</td><td>${esc(r.state)}</td></tr>`).join('');
  return page('Inbox', `<h1>Needs your decision</h1>${pending}<h1>All incidents</h1><div class="card"><table><tr><th>ID<th>Order<th>Rule<th>Risk<th>State</tr>${list}</table></div>`);
}

function decisionForm(r) {
  const c = r.chosen;
  const edit = c?.type === 'partial_refund' ? `<label class="mute">Amount (USD) <input name="amount" type="number" step="0.01" value="${(c.amountCents / 100).toFixed(2)}" style="width:100px"></label>` : c?.type === 'new_eta' ? `<label class="mute">ETA <input name="eta" type="date" value="${esc(c.eta)}"></label>` : '';
  return `<form method="post" action="/merchant/incidents/${r.inc.id}/decision" class="row"><input type="hidden" name="token" value="${esc(r.inc.approval_token)}">${edit}
${c ? '<button name="action" value="approve">Approve</button>' : ''}${c && edit ? '<button class="ghost" name="action" value="edit">Approve edited</button>' : ''}<button class="danger" name="action" value="reject">Reject</button></form>`;
}

export function incidentPage(inc, order, audit, messages, flash) {
  const rows = audit.map((a) => `<tr><td class="mute">${esc(a.ts.slice(0, 16).replace('T', ' '))}</td><td>${esc(a.kind)}</td><td>${esc(a.actor)}</td><td><pre class="mute">${esc(JSON.stringify(a.data))}</pre></td></tr>`).join('');
  const msgs = messages.map((m) => `<div class="msg"><span class="pill">${m.direction === 'out' ? 'to buyer' : 'from buyer'}</span><pre>${esc(m.body)}</pre></div>`).join('');
  return page(`Incident ${inc.id}`, `<h1>Incident #${inc.id} · ${esc(order.merchant_order_id)}</h1>${flash ? `<div class="card">${esc(flash)}</div>` : ''}<div class="card"><p>${esc(inc.issue)}: ${esc(inc.reason)}</p><p class="mute">Rule ${esc(inc.rule)} · state ${esc(inc.state)} · capture ${esc(order.capture_id)}</p></div><div class="card"><h2>Messages</h2>${msgs || '<p class="mute">None yet.</p>'}</div><div class="card"><h2>Audit log</h2><table>${rows}</table></div>`);
}

export function dashboardPage(d) {
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const min = (v) => (v == null ? '—' : `${v < 1 ? '<1' : Math.round(v)} min`);
  const stat = (n, l) => `<div class="card stat"><b>${n}</b><span>${l}</span></div>`;
  return page('Dashboard', `<h1>Outcomes</h1><div class="grid">${stat(d.flagged, 'At-risk orders flagged')}${stat(d.resolved, 'Resolved')}${stat(d.open, 'Open')}${stat(fmt(d.refundCents), `Refunds issued (${d.refundsCount})`)}${stat(d.disputesOpened, 'Disputes opened')}${stat(d.blockedProposals, 'Out-of-policy actions blocked')}${stat(pct(d.resolutionRate), 'Pre-dispute resolution rate')}${stat(min(d.avgMinutesToContact), 'Avg time to buyer contact')}${stat(min(d.avgMinutesToDecision), 'Avg buyer-to-resolution')}</div>`);
}

export function policyPage(p, saved) {
  const box = (r) => `<label style="display:block"><input type="checkbox" name="allowedRemedies" value="${r}" ${p.allowedRemedies.includes(r) ? 'checked' : ''}> ${r}</label>`;
  return page('Policy', `<h1>Merchant policy</h1>${saved ? '<div class="card">Saved. The next incident uses these rules.</div>' : ''}<form method="post" class="card">
<h2>Allowed remedies</h2>${REMEDIES.map(box).join('')}
<p><label>Refund cap (% of order) <input name="refundCapPercent" type="number" value="${p.refundCapPercent}" style="width:80px"></label></p>
<p><label>Refund cap (USD) <input name="refundCapUsd" type="number" step="0.01" value="${(p.refundCapCents / 100).toFixed(2)}" style="width:100px"></label></p>
<p><label>Auto-approve refunds up to (USD) <input name="autoApproveUsd" type="number" step="0.01" value="${(p.autoApproveCents / 100).toFixed(2)}" style="width:100px"></label></p>
<p><label>Max new ETA (days out) <input name="maxEtaDays" type="number" value="${p.maxEtaDays}" style="width:80px"></label></p>
<p><label>Tone <select name="tone">${['friendly', 'formal', 'concise'].map((t) => `<option ${p.tone === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label></p>
<button>Save policy</button></form>`);
}

export function devPage(orders, flash) {
  const rows = orders.map((o) => `<tr><td>${esc(o.merchant_order_id)}</td><td>${fmt(o.amount_cents)}</td><td>${esc(o.promised_date)}</td><td>${esc(o.tracking_number || '—')}</td><td>${esc(o.status || '—')}</td></tr>`).join('');
  return page('Simulator', `<h1>Simulator</h1>${flash ? `<div class="card">${esc(flash)}</div>` : ''}
<div class="card"><h2>Seed a scenario</h2><p class="mute">Creates a paid order and ships it. The carrier timeline plays out as you advance days.</p>
<form method="post" action="/dev/seed" class="row"><select name="scenario"><option value="delayed">Carrier delay</option><option value="failed">Delivery failed</option><option value="stalled">No scan (stalled)</option><option value="returned">Returned to sender</option></select><input name="amount" type="number" step="0.01" value="60.00" style="width:100px"><button>Seed</button></form></div>
<div class="card"><h2>Clock</h2><form method="post" action="/dev/advance" class="row"><input name="days" type="number" value="3" style="width:70px"> days <button>Advance and poll</button></form></div>
<div class="card"><h2>Orders</h2><table><tr><th>Order<th>Total<th>Promised<th>Tracking<th>Status</tr>${rows}</table></div>`);
}
