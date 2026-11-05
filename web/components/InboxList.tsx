'use client';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fetchInbox } from '@/lib/queries';
import { RULE_LABEL, lastScanAt, sortInbox, stateMeta } from '@/lib/stage';
import { timeAgo, usd } from '@/lib/format';
import type { Incident } from '@/lib/types';
import { Banner, EmptyState, RiskChip, StateBadge } from './ui';
import { useRealtime } from './useRealtime';

export default function InboxList({ initial }: { initial: Incident[] }) {
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setRows(await fetchInbox(createClient())); setError(null); } catch { setError('Live updates paused. Reload to retry.'); }
  }, []);
  useRealtime('inbox', ['incidents', 'offers'], refresh);

  const sorted = sortInbox(rows);
  const open = sorted.filter((r) => !['RESOLVED', 'EXPIRED'].includes(r.state));
  const done = sorted.filter((r) => ['RESOLVED', 'EXPIRED'].includes(r.state));
  const count = (f: (r: Incident) => boolean) => rows.filter(f).length;

  if (rows.length === 0) {
    return <EmptyState title="No orders at risk">New incidents appear here the moment a shipment stalls. Try the <Link className="font-semibold text-accent underline" href="/demo">demo panel</Link>.</EmptyState>;
  }
  return (
    <div className="space-y-8">
      {error && <Banner tone="warn" title={error} />}
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Needs you" value={count((r) => stateMeta(r.state).needsAction && r.state !== 'DISPUTED')} tone="warn" />
        <Stat label="With the buyer" value={count((r) => ['OPEN', 'OFFERED', 'EXECUTING'].includes(r.state))} tone="accent" />
        <Stat label="Resolved" value={count((r) => r.state === 'RESOLVED')} tone="ok" />
        <Stat label="Disputed" value={count((r) => r.state === 'DISPUTED')} tone="bad" />
      </dl>

      {open.length > 0 && (
        <section aria-label="Open incidents">
          <h2 className="eyebrow mb-3">Open now · {open.length}</h2>
          <ul className="space-y-3">{open.map((r) => <Row key={r.id} inc={r} />)}</ul>
        </section>
      )}
      {done.length > 0 && (
        <section aria-label="Closed incidents">
          <h2 className="eyebrow mb-3">Closed · {done.length}</h2>
          <ul className="space-y-3">{done.map((r) => <Row key={r.id} inc={r} />)}</ul>
        </section>
      )}
    </div>
  );
}

const STAT_TONE = { warn: 'text-warn', accent: 'text-accent', ok: 'text-ok', bad: 'text-bad' } as const;
const Stat = ({ label, value, tone }: { label: string; value: number; tone: keyof typeof STAT_TONE }) => (
  <div className="card !p-4 sm:!p-5">
    <dt className="eyebrow">{label}</dt>
    <dd className={`mt-1 text-4xl font-bold tabular-nums ${value ? STAT_TONE[tone] : 'text-mute/60'}`}>{value}</dd>
  </div>
);

const RAIL: Record<string, string> = { warn: 'bg-warn', bad: 'bg-bad', ok: 'bg-ok', accent: 'bg-accent', neutral: 'bg-line' };

function Row({ inc }: { inc: Incident }) {
  const scan = lastScanAt(inc);
  const meta = stateMeta(inc.state);
  return (
    <li>
      <Link href={`/inbox/${inc.id}`} className="group relative block overflow-hidden rounded-2xl border border-line bg-card p-5 pl-7 shadow-card transition hover:-translate-y-px hover:shadow-lift">
        <span className={`absolute inset-y-0 left-0 w-1.5 ${RAIL[meta.tone]}`} aria-hidden />
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-bold">{inc.orders.merchant_order_id}</span>
              <RiskChip level={inc.risk_level} />
              <StateBadge state={inc.state} />
            </div>
            <p className="mt-2 max-w-2xl text-[15px]">{inc.ai_reason ?? 'The agent is assessing this order.'}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tabular-nums">{usd(inc.orders.amount_cents)}</p>
            <p className="text-sm text-mute">{inc.orders.buyer_name}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-mute">
          <p>{RULE_LABEL[inc.rule_fired] ?? inc.rule_fired} <span aria-hidden>·</span> last scan {scan ? timeAgo(scan) : 'none yet'} <span aria-hidden>·</span> opened {timeAgo(inc.opened_at)}</p>
          {meta.needsAction && <span className="font-semibold text-accent group-hover:underline">Review →</span>}
        </div>
      </Link>
    </li>
  );
}
