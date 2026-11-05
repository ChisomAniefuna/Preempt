'use client';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseUsdToCents, usd } from '@/lib/format';
import { REMEDIES, type Policy, type Remedy } from '@/lib/types';
import { Banner, Spinner } from './ui';

const REMEDY: Record<Remedy, { title: string; help: string; icon: string }> = {
  NEW_ETA: { title: 'New delivery date', help: 'Offer a later date and keep the order moving.', icon: 'M3 5h18v16H3zM16 3v4M8 3v4M3 11h18' },
  RESHIP: { title: 'Reship', help: 'Send a replacement with new tracking.', icon: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8' },
  PARTIAL_REFUND: { title: 'Partial refund', help: 'Refund part of the order, within the limits below.', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.5 2.5 1.5-1 1.5-2.5 2-2.5 1-2.5 2 1 1.5 2.5 1.5 2.5-.5 2.5-1.5' },
  FULL_REFUND: { title: 'Full refund', help: 'Refund the whole order. Off by default; use with care.', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12h8' },
};
const TONES = [['warm', 'Warm', 'Friendly and reassuring'], ['formal', 'Formal', 'Polite and businesslike'], ['concise', 'Concise', 'Short and to the point']] as const;
const EXAMPLE_ORDER_CENTS = 4800;

export default function PolicyForm({ initial }: { initial: Policy }) {
  const [remedies, setRemedies] = useState<Remedy[]>(initial.allowed_remedies);
  const [percent, setPercent] = useState(String(initial.max_refund_percent));
  const [cap, setCap] = useState((initial.max_refund_cents / 100).toFixed(2));
  const [auto, setAuto] = useState((initial.auto_approve_cents / 100).toFixed(2));
  const [days, setDays] = useState(String(initial.no_scan_days));
  const [tone, setTone] = useState(initial.tone);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const p = Number(percent), capC = parseUsdToCents(cap), autoC = parseUsdToCents(auto);
  const example = Number.isFinite(p) && capC !== null ? Math.max(0, Math.min(Math.floor((EXAMPLE_ORDER_CENTS * p) / 100), capC)) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const d = Number(days);
    if (remedies.length === 0) return setError('Allow at least one remedy.');
    if (!Number.isInteger(p) || p < 0 || p > 100) return setError('Refund cap percent must be a whole number from 0 to 100.');
    if (capC === null || autoC === null) return setError('Dollar amounts must be numbers like 15.00.');
    if (!Number.isInteger(d) || d < 1) return setError('No-scan days must be 1 or more.');
    setBusy(true); setError(null);
    const { error } = await createClient().from('policies').update({
      allowed_remedies: remedies, max_refund_percent: p, max_refund_cents: capC, auto_approve_cents: autoC, no_scan_days: d, tone, updated_at: new Date().toISOString(),
    }).eq('merchant_id', initial.merchant_id);
    setBusy(false);
    if (error) setError(error.message); else { setError(null); setSaved(true); }
  }

  return (
    <form onSubmit={submit} className="space-y-6" onChange={() => setSaved(false)}>
      <section className="card" aria-labelledby="rem">
        <p className="eyebrow">What the agent may offer</p>
        <h2 id="rem" className="mt-1 text-xl font-bold">Remedies</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {REMEDIES.map((r) => {
            const on = remedies.includes(r);
            return (
              <label key={r} className="relative block cursor-pointer">
                <input type="checkbox" className="peer sr-only" checked={on} onChange={(e) => setRemedies(e.target.checked ? [...remedies, r] : remedies.filter((x) => x !== r))} />
                <div className="flex h-full gap-3 rounded-xl border-2 border-line p-4 transition peer-checked:border-accent peer-checked:bg-accent-bg peer-focus-visible:ring-2 peer-focus-visible:ring-accent hover:border-mute/50">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${on ? 'bg-accent text-bg' : 'bg-line/60 text-mute'}`} aria-hidden>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={REMEDY[r].icon} /></svg>
                  </span>
                  <span className="min-w-0 flex-1"><span className="block font-semibold">{REMEDY[r].title}</span><span className="block text-sm text-mute">{REMEDY[r].help}</span></span>
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold ${on ? 'border-accent bg-accent text-bg' : 'border-line'}`} aria-hidden>{on && '✓'}</span>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      <section className="card" aria-labelledby="lim">
        <p className="eyebrow">Hard limits, enforced in code</p>
        <h2 id="lim" className="mt-1 text-xl font-bold">Limits</h2>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Field id="pct" label="Max refund, as a percent" suffix="% of order" value={percent} onChange={setPercent} hint="The model can propose a number, but never above this." />
          <Field id="cap" label="Max refund, in dollars" prefix="$" value={cap} onChange={setCap} hint="The lower of the two caps applies." />
          <Field id="auto" label="Auto-approve up to" prefix="$" value={auto} onChange={setAuto} hint="New dates and refunds at or below this skip your approval. 0 turns it off." />
          <Field id="days" label="Flag after" suffix="days without a scan" value={days} onChange={setDays} hint="Takes effect on the next check." />
        </div>
        {example !== null && (
          <p className="mt-5 rounded-xl bg-bg p-4 text-sm">
            <span className="font-semibold">In practice:</span> on a {usd(EXAMPLE_ORDER_CENTS)} order the agent can refund up to <strong>{usd(example)}</strong>.{' '}
            {autoC === 0 ? 'Every choice waits for your approval.' : <>Anything up to <strong>{usd(autoC ?? 0)}</strong> is approved automatically{(autoC ?? 0) >= example && example > 0 ? ', so every refund on this order would be' : ''}.</>}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="tone">
        <p className="eyebrow">How buyers hear from you</p>
        <h2 id="tone" className="mt-1 text-xl font-bold">Tone</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-labelledby="tone">
          {TONES.map(([id, title, help]) => (
            <label key={id} className="relative block cursor-pointer">
              <input type="radio" name="tone" className="peer sr-only" checked={tone === id} onChange={() => setTone(id)} />
              <div className="rounded-xl border-2 border-line p-4 transition peer-checked:border-accent peer-checked:bg-accent-bg peer-focus-visible:ring-2 peer-focus-visible:ring-accent hover:border-mute/50">
                <span className="block font-semibold">{title}</span><span className="block text-sm text-mute">{help}</span>
              </div>
            </label>
          ))}
        </div>
      </section>

      <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card/95 p-3 shadow-lift backdrop-blur">
        <button className="btn" disabled={busy}>{busy ? <Spinner label="Saving" /> : 'Save policy'}</button>
        <p className="text-sm text-mute">{saved ? <span className="font-semibold text-ok">✓ Saved. The next incident uses this policy.</span> : 'Changes apply to the next incident.'}</p>
      </div>
      {error && <Banner title={error} />}
    </form>
  );
}

function Field({ id, label, value, onChange, hint, prefix, suffix }: { id: string; label: string; value: string; onChange: (v: string) => void; hint: string; prefix?: string; suffix?: string }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute">{prefix}</span>}
        <input id={id} inputMode="decimal" className={`input tabular-nums ${prefix ? 'pl-8' : ''} ${suffix ? 'pr-32' : ''}`} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-h`} />
        {suffix && <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-mute">{suffix}</span>}
      </div>
      <p id={`${id}-h`} className="mt-1.5 text-xs text-mute">{hint}</p>
    </div>
  );
}
