'use client';
import { useState, type ReactNode } from 'react';
import { stateMeta } from '@/lib/stage';
import { titleCase } from '@/lib/format';

const TONE = {
  neutral: { chip: 'bg-line/60 text-mute', dot: 'bg-mute', box: 'border-line bg-card text-ink' },
  accent: { chip: 'bg-accent-bg text-accent', dot: 'bg-accent', box: 'border-accent/30 bg-accent-bg text-ink' },
  ok: { chip: 'bg-ok-bg text-ok', dot: 'bg-ok', box: 'border-ok/30 bg-ok-bg text-ink' },
  warn: { chip: 'bg-warn-bg text-warn', dot: 'bg-warn', box: 'border-warn/30 bg-warn-bg text-ink' },
  bad: { chip: 'bg-bad-bg text-bad', dot: 'bg-bad', box: 'border-bad/30 bg-bad-bg text-ink' },
} as const;
export type Tone = keyof typeof TONE;

export const Pill = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone].chip}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${TONE[tone].dot}`} aria-hidden />
    {children}
  </span>
);

export const RiskChip = ({ level }: { level: string | null }) =>
  level ? <Pill tone={level === 'HIGH' ? 'bad' : level === 'MEDIUM' ? 'warn' : 'ok'}>{titleCase(level)} risk</Pill> : <Pill>Assessing</Pill>;

export const StateBadge = ({ state }: { state: string }) => {
  const m = stateMeta(state);
  return <Pill tone={m.tone}>{m.label}</Pill>;
};

/** A PayPal ID in a monospace chip with a copy button, so the sandbox work is visible. */
export function IdChip({ label, value, block }: { label: string; value: string | null | undefined; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = () => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  return (
    <div className={`${block ? 'flex' : 'inline-flex'} max-w-full items-center gap-2 rounded-xl border border-line bg-bg px-3 py-1.5 text-xs`}>
      <span className="eyebrow shrink-0 !text-[10px]">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{value}</code>
      <button type="button" aria-label={`Copy ${label}`} className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-accent hover:bg-accent-bg" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export const Banner = ({ tone = 'bad', title, children }: { tone?: 'bad' | 'warn' | 'ok' | 'accent'; title?: string; children?: ReactNode }) => (
  <div role={tone === 'bad' ? 'alert' : 'status'} className={`flex gap-3 rounded-2xl border px-4 py-3 text-sm ${TONE[tone].box}`}>
    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[tone].dot}`} aria-hidden />
    <div className="min-w-0">
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className="text-ink/80">{children}</div>}
    </div>
  </div>
);

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <span role="status" className="inline-flex items-center gap-2 text-sm">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/25 border-t-current" aria-hidden />
    {label}
  </span>
);

export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="card py-14 text-center">
    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-bg text-accent" aria-hidden>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
    </div>
    <p className="text-lg font-semibold">{title}</p>
    {children && <div className="mx-auto mt-1 max-w-sm text-sm text-mute">{children}</div>}
  </div>
);

export const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div aria-busy="true" className="space-y-3">
    {Array.from({ length: rows }, (_, i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-line/60" />)}
  </div>
);

export const PageTitle = ({ children, sub, right }: { children: ReactNode; sub?: ReactNode; right?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-3xl font-bold">{children}</h1>
      {sub && <p className="mt-1 max-w-2xl text-[15px] text-mute">{sub}</p>}
    </div>
    {right}
  </div>
);

export const Logo = ({ size = 32 }: { size?: number }) => (
  <span className="inline-flex items-center justify-center rounded-[10px] bg-accent text-bg" style={{ width: size, height: size }} aria-hidden>
    <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h11" /><path d="m12 6 6 6-6 6" /></svg>
  </span>
);
