'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ApiError, callFunction } from '@/lib/api';
import { Banner, IdChip, Spinner } from './ui';

const SCENARIOS = [
  { id: 'stall', title: 'Stalled shipment', body: 'No carrier scan after day 2. The classic "where is my parcel?"', outcome: 'Gets flagged', flagged: true, icon: 'M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z' },
  { id: 'failed', title: 'Delivery failed', body: 'The carrier could not deliver on day 4.', outcome: 'Gets flagged', flagged: true, icon: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
  { id: 'returned', title: 'Returned to sender', body: 'The parcel comes back on day 6.', outcome: 'Gets flagged', flagged: true, icon: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3' },
  { id: 'on_time', title: 'On time', body: 'Delivered by the promised date.', outcome: 'Nothing flagged', flagged: false, icon: 'M20 6 9 17l-5-5' },
] as const;

interface ScenarioResult { order?: { merchant_order_id?: string; paypal_order_id?: string; capture_id?: string }; tracker_id?: string; tracking_number?: string }

export default function DemoPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ scenario: string; data: ScenarioResult } | null>(null);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [days, setDays] = useState(5);
  const [error, setError] = useState<string | null>(null);

  async function go(key: string, fn: () => Promise<void>) {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as ApiError).message); } finally { setBusy(null); }
  }

  return (
    <ol className="space-y-6">
      <Step n={1} title="Create a sandbox order" sub="A real PayPal sandbox payment with tracking, plus a simulated carrier timeline.">
        <div className="grid gap-3 sm:grid-cols-2">
          {SCENARIOS.map((s) => (
            <div key={s.id} className="card flex flex-col !p-5">
              <div className="flex items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${s.flagged ? 'bg-warn-bg text-warn' : 'bg-ok-bg text-ok'}`} aria-hidden>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={s.icon} /></svg>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{s.title}</p>
                  <p className="text-sm text-mute">{s.body}</p>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className={`text-xs font-semibold ${s.flagged ? 'text-warn' : 'text-ok'}`}>{s.outcome}</span>
                <button className="btn !min-h-[40px] !px-4" disabled={busy !== null}
                  onClick={() => go(s.id, async () => setResult({ scenario: s.title, data: await callFunction<ScenarioResult>('/demo/scenario', { method: 'POST', body: { scenario: s.id } }) }))}>
                  {busy === s.id ? <Spinner label="Creating" /> : 'Run'}
                </button>
              </div>
            </div>
          ))}
        </div>
        {result && (
          <div className="mt-3">
            <Banner tone="ok" title={`Created: ${result.scenario}`}>
              <div className="mt-2 flex flex-wrap gap-2">
                <IdChip label="Order" value={result.data.order?.paypal_order_id} />
                <IdChip label="Capture" value={result.data.order?.capture_id} />
                <IdChip label="Tracker" value={result.data.tracker_id ?? result.data.tracking_number} />
              </div>
            </Banner>
          </div>
        )}
      </Step>

      <Step n={2} title="Advance the carrier clock" sub="Jumps simulated time forward and runs the watcher right away, so you don't wait for the 30-second schedule.">
        <div className="card flex flex-wrap items-end gap-4">
          <div>
            <span className="label">Days to jump</span>
            <div className="inline-flex gap-1 rounded-xl bg-bg p-1" role="radiogroup" aria-label="Days to jump">
              {[1, 2, 3, 5, 7].map((d) => (
                <button key={d} type="button" role="radio" aria-checked={days === d} onClick={() => setDays(d)}
                  className={`min-h-[40px] min-w-[44px] rounded-lg px-3 text-sm font-semibold transition ${days === d ? 'bg-card text-accent shadow-card' : 'text-mute hover:text-ink'}`}>{d}</button>
              ))}
            </div>
          </div>
          <button className="btn" disabled={busy !== null}
            onClick={() => go('advance', async () => { await callFunction('/demo/advance', { method: 'POST', body: { days } }); setAdvanced(`Advanced ${days} day${days === 1 ? '' : 's'} and ran the watcher.`); })}>
            {busy === 'advance' ? <Spinner label="Running watcher" /> : 'Advance and run'}
          </button>
        </div>
        {advanced && <div className="mt-3"><Banner tone="ok" title={advanced}>Open the <Link href="/inbox" className="font-semibold underline">inbox</Link> to see what the agent flagged.</Banner></div>}
      </Step>

      {error && <Banner title="That did not work">{error}</Banner>}

      <Step n={3} title="Play both sides">
        <ol className="card space-y-3 text-sm">
          {[
            ['Buyer', <>Open the incident in the <Link href="/inbox" className="font-semibold text-accent underline">inbox</Link>, copy the buyer link, and open it in a phone-width window. Pick a fix.</>],
            ['Merchant', <>Back in the inbox, approve the choice. Small refunds approve themselves.</>],
            ['PayPal', <>Watch the refund or tracker ID appear on the incident, with every decision in the audit trail.</>],
          ].map(([who, text], i) => (
            <li key={i} className="flex gap-3"><span className="eyebrow w-16 shrink-0 pt-0.5">{who}</span><span>{text}</span></li>
          ))}
        </ol>
      </Step>
    </ol>
  );
}

function Step({ n, title, sub, children }: { n: number; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-bg" aria-hidden>{n}</span>
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-bold leading-8">{title}</h2>
        {sub && <p className="mb-3 text-sm text-mute">{sub}</p>}
        {!sub && <div className="mb-3" />}
        {children}
      </div>
    </li>
  );
}
