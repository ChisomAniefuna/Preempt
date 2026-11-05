import { EmptyState, PageTitle } from '@/components/ui';
import { fetchDashboard } from '@/lib/queries';
import { usd } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

export default async function DashboardPage() {
  const d = await fetchDashboard(await createClient());
  const opened = Number(d?.incidents_opened ?? 0);
  const resolved = Number(d?.resolved_without_dispute ?? 0);
  const rate = opened ? Math.round((resolved / opened) * 100) : null;
  const avoided = Number(d?.estimated_cost_avoided_cents ?? 0);
  const disputed = Number(d?.disputes_opened ?? 0);
  const stillOpen = Math.max(0, opened - resolved - disputed);
  const seg = (n: number) => (opened ? `${(n / opened) * 100}%` : '0%');
  return (
    <>
      <PageTitle sub="Every number is counted straight from the audited records.">Outcomes</PageTitle>
      {opened === 0 ? <EmptyState title="Nothing to report yet">Run a scenario from the demo panel to see outcomes here.</EmptyState> : (
        <div className="space-y-4">
          <section className="card !bg-accent !text-bg">
            <div className="grid gap-6 sm:grid-cols-[1.4fr_1fr] sm:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider opacity-75">Estimated cost avoided</p>
                <p className="mt-1 text-6xl font-bold tabular-nums">{usd(avoided)}</p>
                <p className="mt-1 text-sm opacity-80">{resolved} order{resolved === 1 ? '' : 's'} fixed before a dispute, at about $315 all-in cost per dispute</p>
              </div>
              {rate !== null && (
                <div className="sm:border-l sm:border-bg/25 sm:pl-6">
                  <p className="text-6xl font-bold tabular-nums">{rate}%</p>
                  <p className="text-sm opacity-80">of flagged orders resolved</p>
                </div>
              )}
            </div>
          </section>

          <section className="card" aria-label="Where flagged orders ended up">
            <p className="eyebrow">Where flagged orders ended up</p>
            <div className="mt-3 flex h-4 overflow-hidden rounded-full bg-line/60" role="img" aria-label={`${resolved} resolved, ${stillOpen} still open, ${disputed} disputed`}>
              <span className="bg-ok" style={{ width: seg(resolved) }} />
              <span className="bg-accent/50" style={{ width: seg(stillOpen) }} />
              <span className="bg-bad" style={{ width: seg(disputed) }} />
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <Legend color="bg-ok" label="Resolved" n={resolved} />
              <Legend color="bg-accent/50" label="Still open" n={stillOpen} />
              <Legend color="bg-bad" label="Disputed anyway" n={disputed} />
            </ul>
          </section>

          <dl className="grid gap-4 sm:grid-cols-3">
            <Tile label="Orders flagged" value={String(opened)} note="Caught before the buyer complained" />
            <Tile label="Refunds issued" value={usd(Number(d?.refunds_issued_cents ?? 0))} note={`${d?.refunds_count ?? 0} refund${Number(d?.refunds_count) === 1 ? '' : 's'}, kept deliberately small`} />
            <Tile label="Disputed anyway" value={String(disputed)} tone={disputed ? 'bad' : undefined} note="Handed over with a full timeline" />
          </dl>
        </div>
      )}
    </>
  );
}

const Legend = ({ color, label, n }: { color: string; label: string; n: number }) => (
  <li className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${color}`} aria-hidden />{label} <span className="font-semibold tabular-nums">{n}</span></li>
);

const Tile = ({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'bad' }) => (
  <div className="card">
    <dt className="eyebrow">{label}</dt>
    <dd className={`mt-1 text-4xl font-bold tabular-nums ${tone === 'bad' ? 'text-bad' : ''}`}>{value}</dd>
    {note && <dd className="mt-1 text-sm text-mute">{note}</dd>}
  </div>
);
