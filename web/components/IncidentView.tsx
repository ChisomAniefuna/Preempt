'use client';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { ApiError, callFunction } from '@/lib/api';
import { fetchIncident } from '@/lib/queries';
import { RULE_LABEL, STEPS, latestOffer, optionLabel, progressIndex, stateMeta, violationText } from '@/lib/stage';
import { dateTime, parseUsdToCents, shortDate, timeAgo, titleCase, usd } from '@/lib/format';
import type { AuditEvent, Incident, Offer, Option } from '@/lib/types';
import { Banner, IdChip, Pill, RiskChip, Spinner, StateBadge } from './ui';
import { useRealtime } from './useRealtime';

export default function IncidentView({ initial, initialAudit }: { initial: Incident; initialAudit: AuditEvent[] }) {
  const [inc, setInc] = useState(initial);
  const [audit, setAudit] = useState(initialAudit);

  const refresh = useCallback(async () => {
    const r = await fetchIncident(createClient(), initial.id).catch(() => null);
    if (r?.incident) { setInc(r.incident); setAudit(r.audit); }
  }, [initial.id]);
  useRealtime(`incident-${initial.id}`, ['incidents', 'offers', 'actions', 'audit_events'], refresh);

  const offer = latestOffer(inc.offers);
  const order = inc.orders;
  const shipment = order.shipments?.[0];
  const actions = (inc.offers ?? []).flatMap((o) => o.actions ?? []);
  const done = actions.find((a) => a.status === 'COMPLETED');
  const failed = actions.filter((a) => a.status === 'FAILED').at(-1);
  const step = progressIndex(inc.state, offer);
  // The signed buyer link is only known when it is created, so it lives in the audit trail. Show it here too
  // (the PRD's fallback if the email lands in spam).
  const buyerLink = [...audit].reverse().find((a) => a.kind === 'BUYER_LINK_CREATED' && (a.input as { offerId?: string } | null)?.offerId === offer?.id)?.output as { url?: string } | undefined;

  return (
    <div>
      <Link href="/inbox" className="text-sm font-semibold text-accent hover:underline">← Inbox</Link>
      <div className="mb-6 mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold">{order.merchant_order_id}</h1>
            <RiskChip level={inc.risk_level} />
            <StateBadge state={inc.state} />
          </div>
          <p className="mt-1 text-mute">{order.buyer_name} · promised {shortDate(order.promised_by)}</p>
        </div>
        <p className="text-4xl font-bold tabular-nums">{usd(order.amount_cents)}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          {inc.state === 'DISPUTED' && <Banner title="The buyer opened a PayPal dispute">Outreach has stopped and no further refund will be issued. The audit trail below shows everything that was offered.</Banner>}
          {inc.state === 'NEEDS_MERCHANT' && <Banner tone="warn" title="The agent needs you">{offer?.status === 'BLOCKED' ? 'Two proposals were blocked by your policy.' : 'The buyer asked for something outside your policy.'} Handle this one directly, or adjust your <Link href="/policy" className="font-semibold underline">policy</Link>.</Banner>}
          {inc.state === 'EXPIRED' && <Banner tone="accent" title="The buyer link expired without a choice" />}
          {inc.state === 'RESOLVED' && done && <Banner tone="ok" title="Resolved without a dispute">{done.type === 'REFUND' ? `Refunded ${usd(done.amount_cents)} through PayPal.` : done.type === 'RESHIP' ? 'A replacement was shipped and tracking was added to PayPal.' : 'The buyer has a new delivery date.'}</Banner>}
          {failed && inc.state === 'ACTION_FAILED' && <Banner title="PayPal rejected the action">{failed.error?.message ?? 'Unknown error.'} Retrying reuses the same idempotency key, so it cannot pay twice.</Banner>}

          <section className="card">
            <p className="eyebrow">What the agent saw</p>
            <h2 className="mt-1 text-xl font-bold">{RULE_LABEL[inc.rule_fired] ?? inc.rule_fired}</h2>
            <p className="mt-2 text-base">{inc.ai_reason ?? 'The agent is still assessing this order.'}</p>
            {shipment && <Timeline shipment={shipment} />}
          </section>

          {offer ? <OfferCard key={offer.id} offer={offer} incState={inc.state} order={order} onChanged={refresh} buyerLink={buyerLink?.url} /> : (
            <section className="card"><Spinner label="The agent is drafting an offer" /></section>
          )}

          <section className="card">
            <p className="eyebrow">Audit trail</p>
            <h2 className="mt-1 text-xl font-bold">Every decision, in order</h2>
            {audit.length === 0 ? <p className="mt-2 text-sm text-mute">No events yet.</p> : (
              <ol className="mt-4 space-y-0">
                {audit.map((a, i) => (
                  <li key={a.id} className="relative flex gap-4 pb-4 last:pb-0">
                    {i < audit.length - 1 && <span className="absolute left-[5px] top-4 h-full w-px bg-line" aria-hidden />}
                    <span className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-card ${ACTOR_DOT[a.actor] ?? 'bg-mute'}`} aria-hidden />
                    <div className="min-w-0 flex-1 text-sm">
                      <p><span className="font-semibold">{a.kind.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span> <span className="text-mute">· {titleCase(a.actor)}</span></p>
                      <time className="text-xs text-mute" dateTime={a.created_at}>{dateTime(a.created_at)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <section className="card" aria-label="Progress">
            <p className="eyebrow mb-3">Progress</p>
            <ol className="space-y-0">
              {STEPS.map((s, i) => {
                const state = i < step ? 'done' : i === step ? 'now' : 'todo';
                return (
                  <li key={s} aria-current={state === 'now' ? 'step' : undefined} className="relative flex items-center gap-3 pb-4 last:pb-0">
                    {i < STEPS.length - 1 && <span className={`absolute left-[11px] top-6 h-full w-0.5 ${state === 'done' ? 'bg-ok' : 'bg-line'}`} aria-hidden />}
                    <span className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${state === 'done' ? 'bg-ok text-bg' : state === 'now' ? 'bg-accent text-bg ring-4 ring-accent-bg' : 'border border-line bg-bg text-mute'}`}>
                      {state === 'done' ? '✓' : i + 1}
                    </span>
                    <span className={`text-sm ${state === 'todo' ? 'text-mute' : 'font-semibold'}`}>{s}</span>
                  </li>
                );
              })}
            </ol>
          </section>
          <section className="card space-y-2" aria-label="PayPal records">
            <p className="eyebrow mb-1">PayPal records</p>
            <IdChip block label="Capture" value={order.capture_id} />
            <IdChip block label="Tracker" value={shipment?.paypal_tracker_id} />
            <IdChip block label="Refund" value={done?.type === 'REFUND' ? done.paypal_ref_id : null} />
            {inc.dispute_id && <IdChip block label="Dispute" value={inc.dispute_id} />}
            <dl className="!mt-4 grid grid-cols-2 gap-y-1 border-t border-line pt-3 text-sm">
              <dt className="text-mute">Paid</dt><dd className="text-right font-medium tabular-nums">{usd(order.amount_cents)}</dd>
              <dt className="text-mute">Refunded</dt><dd className="text-right font-medium tabular-nums">{usd(order.refunded_cents)}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

const ACTOR_DOT: Record<string, string> = { RULE: 'bg-warn', AGENT: 'bg-accent', VALIDATOR: 'bg-ok', MERCHANT: 'bg-ink', BUYER: 'bg-bad', EXECUTOR: 'bg-ok', WEBHOOK: 'bg-bad', POLICY: 'bg-ink' };

function Timeline({ shipment }: { shipment: NonNullable<Incident['orders']['shipments']>[number] }) {
  const events = [...(shipment.events ?? [])].reverse();
  return (
    <div className="mt-5 rounded-xl border border-line bg-bg p-4">
      <p className="text-sm"><span className="font-semibold">{shipment.carrier}</span> <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">{shipment.tracking_number}</code> <span className="text-mute">· {shipment.last_status?.replace(/_/g, ' ').toLowerCase() ?? 'no status'} · last scan {timeAgo(shipment.last_scan_at)}</span></p>
      {events.length > 0 && (
        <ol className="mt-3 space-y-1.5 border-l-2 border-line pl-4 text-sm">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className={`absolute -left-[22px] top-1.5 h-2 w-2 rounded-full ${i === 0 ? 'bg-accent' : 'bg-line'}`} aria-hidden />
              <span className={i === 0 ? 'font-semibold' : ''}>{e.status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>
              <span className="text-mute">{e.location ? ` · ${e.location}` : ''}{e.day != null ? ` · day ${e.day}` : ''}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function OfferCard({ offer, incState, order, onChanged, buyerLink }: { offer: Offer; incState: string; order: Incident['orders']; onChanged: () => void; buyerLink?: string }) {
  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'edit'>(null);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  const choice = offer.buyer_choice;
  const violations = offer.validator_result?.violations ?? [];
  const canDecide = incState === 'AWAITING_APPROVAL' && !!choice;
  const canRetry = incState === 'ACTION_FAILED';

  async function run(kind: 'approve' | 'reject' | 'edit', fn: () => Promise<unknown>) {
    setBusy(kind); setError(null);
    try { await fn(); setEditing(false); setRejecting(false); onChanged(); }
    catch (e) {
      const err = e as ApiError;
      setError({ message: err.message, details: (err.details ?? []).map((d) => violationText(d as never)) });
    } finally { setBusy(null); }
  }

  return (
    <section className="card space-y-4">
      <div>
        <p className="eyebrow">Offer to the buyer</p>
        <h2 className="mt-1 text-xl font-bold">{choice ? 'The buyer chose' : 'Options sent'}</h2>
      </div>

      {offer.status === 'BLOCKED' && (
        <Banner title="Blocked by your policy">
          <ul className="mt-1 list-disc pl-5">{violations.map((v, i) => <li key={i}>{violationText(v)}</li>)}</ul>
          <p className="mt-1">Nothing was sent to the buyer.</p>
        </Banner>
      )}
      {offer.status !== 'BLOCKED' && violations.length === 0 && <p className="inline-flex items-center gap-1.5 rounded-full bg-ok-bg px-3 py-1 text-xs font-semibold text-ok">✓ Validator passed: every option is inside your policy</p>}

      <ul className="space-y-2.5">
        {offer.options.map((o, i) => {
          const picked = !!choice && choice.type === o.type;
          return (
            <li key={i} className={`flex items-start gap-3 rounded-xl border p-4 ${picked ? 'border-accent bg-accent-bg' : 'border-line'}`}>
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${picked ? 'border-accent bg-accent text-bg' : 'border-line'}`} aria-hidden>{picked && <span className="text-[10px] font-bold">✓</span>}</span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold">{optionLabel(o)} {picked && <span className="ml-1 align-middle"><Pill tone="accent">Buyer's pick</Pill></span>}</p>
                {o.rationale && <p className="text-sm text-mute">{o.rationale}</p>}
              </div>
            </li>
          );
        })}
      </ul>

      {buyerLink && offer.status === 'SENT' && <IdChip label="Buyer link" value={buyerLink} />}

      <details className="text-sm">
        <summary className="cursor-pointer font-semibold text-accent">Message sent to the buyer</summary>
        <p className="mt-2 whitespace-pre-wrap rounded-xl bg-bg p-4">{offer.message}</p>
      </details>

      {offer.buyer_reply && <blockquote className="rounded-xl border-l-4 border-warn bg-warn-bg p-4 text-sm"><p className="eyebrow mb-1">Buyer wrote</p>“{offer.buyer_reply}”</blockquote>}

      {error && <Banner title={error.message}>{error.details.length > 0 && <ul className="mt-1 list-disc pl-5">{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}</Banner>}

      {(canDecide || canRetry) && choice && !editing && !rejecting && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <button className="btn" disabled={busy !== null} onClick={() => run('approve', () => callFunction(`/offers/${offer.id}/approve`, { method: 'POST' }))}>
            {busy === 'approve' ? <Spinner label="Approving" /> : canRetry ? 'Retry' : `Approve ${optionLabel(choice)}`}
          </button>
          {canDecide && choice.type !== 'RESHIP' && <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>}
          {canDecide && <button className="btn btn-danger" onClick={() => setRejecting(true)}>Reject</button>}
        </div>
      )}

      {editing && choice && (
        <EditForm choice={choice} order={order} busy={busy === 'edit'}
          onCancel={() => setEditing(false)}
          onSave={(c) => run('edit', () => callFunction(`/offers/${offer.id}`, { method: 'PATCH', body: { choice: c } }))} />
      )}

      {rejecting && (
        <div className="space-y-2">
          <label htmlFor="note" className="label">Note (optional)</label>
          <textarea id="note" className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn btn-danger" disabled={busy !== null} onClick={() => run('reject', () => callFunction(`/offers/${offer.id}/reject`, { method: 'POST', body: { note } }))}>
              {busy === 'reject' ? <Spinner label="Rejecting" /> : 'Confirm reject'}
            </button>
            <button className="btn btn-ghost" onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

function EditForm({ choice, order, busy, onSave, onCancel }: { choice: Option; order: Incident['orders']; busy: boolean; onSave: (c: Option) => void; onCancel: () => void }) {
  const isMoney = choice.type === 'PARTIAL_REFUND' || choice.type === 'FULL_REFUND';
  const [amount, setAmount] = useState(((choice.amount_cents ?? 0) / 100).toFixed(2));
  const [eta, setEta] = useState(choice.new_eta ?? '');
  const cents = parseUsdToCents(amount);
  const invalid = isMoney ? cents === null || cents <= 0 || cents > order.amount_cents - order.refunded_cents : choice.type === 'NEW_ETA' && !eta;
  return (
    <form className="space-y-3 rounded-xl border border-line bg-bg p-4" onSubmit={(e) => { e.preventDefault(); onSave(isMoney ? { ...choice, amount_cents: cents! } : { ...choice, new_eta: eta }); }}>
      {isMoney ? (
        <div><label className="label" htmlFor="amt">Refund amount (USD)</label><input id="amt" inputMode="decimal" className="input max-w-[160px]" value={amount} onChange={(e) => setAmount(e.target.value)} /><p className="mt-1 text-xs text-mute">Your policy cap is re-checked when you save.</p></div>
      ) : (
        <div><label className="label" htmlFor="eta">New delivery date</label><input id="eta" type="date" className="input max-w-[200px]" value={eta} onChange={(e) => setEta(e.target.value)} /></div>
      )}
      <div className="flex gap-2">
        <button className="btn" disabled={busy || invalid}>{busy ? <Spinner label="Saving" /> : 'Save and re-check'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
