'use client';
import { useEffect, useState } from 'react';
import { ApiError, callFunction } from '@/lib/api';
import { optionLabel } from '@/lib/stage';
import type { BuyerView } from '@/lib/types';
import { Banner, Spinner } from './ui';

type Load = { s: 'loading' } | { s: 'error'; code: string; message: string } | { s: 'ready'; view: BuyerView };

export default function BuyerChoice({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [busy, setBusy] = useState<number | 'reply' | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callFunction<BuyerView>(`/buyer?token=${encodeURIComponent(token)}`, { auth: false })
      .then((view) => setLoad({ s: 'ready', view }))
      .catch((e: ApiError) => setLoad({ s: 'error', code: e.code, message: e.message }));
  }, [token]);

  async function send(body: { choice_index?: number; reply?: string }, key: number | 'reply') {
    setBusy(key); setError(null);
    try {
      const view = await callFunction<BuyerView>('/buyer/choose', { method: 'POST', auth: false, body: { token, ...body } });
      setLoad({ s: 'ready', view });
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(null); }
  }

  if (load.s === 'loading') return <Shell><div className="card"><Spinner label="Loading your order" /></div></Shell>;
  if (load.s === 'error') {
    const expired = load.code === 'TOKEN_EXPIRED';
    return <Shell><Banner tone={expired ? 'warn' : 'bad'} title={expired ? 'This link has expired' : 'We could not open this link'}>
      {expired ? 'Please reply to the seller\'s email and they will help you directly.' : load.message}</Banner></Shell>;
  }

  const v = load.view;
  const closed = v.status !== 'OPEN';
  return (
    <Shell merchant={v.merchant_name}>
      <p className="eyebrow">Order {v.merchant_order_id}</p>
      <h1 className="mt-1 text-2xl font-bold leading-tight">We hit a snag with your order</h1>
      <div className="card mt-4 !p-5"><p className="whitespace-pre-wrap text-[16px] leading-relaxed">{v.message}</p></div>

      {v.status === 'CHOSEN' && (
        <div className="mt-5"><Banner tone="ok" title="Thanks, your choice is in">
          {v.chosen ? <>You picked <strong>{optionLabel(v.chosen)}</strong>. </> : null}{v.reply_ack ?? 'The seller will confirm shortly. You do not need to do anything else.'}
        </Banner></div>
      )}
      {v.status === 'RESOLVED' && <div className="mt-5"><Banner tone="ok" title="All sorted">This order has been taken care of.</Banner></div>}
      {v.status === 'EXPIRED' && <div className="mt-5"><Banner tone="warn" title="This offer is closed">Please reply to the seller&apos;s email and they will help you directly.</Banner></div>}

      {!closed && (
        <>
          <h2 className="mb-3 mt-7 text-lg font-bold">Choose how you&apos;d like us to fix it</h2>
          <ul className="space-y-3">
            {v.options.map((o, i) => (
              <li key={i}>
                <button className="group flex w-full items-center gap-4 rounded-2xl border-2 border-line bg-card p-4 text-left shadow-card transition hover:border-accent hover:shadow-lift focus-visible:border-accent disabled:opacity-60" disabled={busy !== null} onClick={() => send({ choice_index: i }, i)}>
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-bg text-accent" aria-hidden>{ICON[o.type]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-bold">{busy === i ? <Spinner label="Saving your choice" /> : optionLabel(o)}</span>
                    {o.rationale && <span className="mt-0.5 block text-sm text-mute">{o.rationale}</span>}
                  </span>
                  <span className="text-xl text-mute transition group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden>→</span>
                </button>
              </li>
            ))}
          </ul>

          <form className="card mt-7" onSubmit={(e) => { e.preventDefault(); if (reply.trim()) send({ reply: reply.trim() }, 'reply'); }}>
            <label htmlFor="reply" className="label">Prefer something else?</label>
            <textarea id="reply" rows={3} maxLength={1000} className="input" placeholder="Tell us in your own words" value={reply} onChange={(e) => setReply(e.target.value)} />
            <button className="btn btn-ghost mt-3 w-full" disabled={busy !== null || !reply.trim()}>{busy === 'reply' ? <Spinner label="Sending" /> : 'Send to the seller'}</button>
          </form>
        </>
      )}
      {error && <div className="mt-4"><Banner title={error} /></div>}
    </Shell>
  );
}

const ICON: Record<string, React.ReactNode> = {
  NEW_ETA: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></svg>,
  RESHIP: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" /><path d="m3 8 9 5 9-5M12 13v8" /></svg>,
  PARTIAL_REFUND: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M14.5 9a2.5 2 0 0 0-2.5-1.5c-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2A2.5 2 0 0 1 9.5 15M12 6v1.5M12 16.5V18" /></svg>,
  FULL_REFUND: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M14.5 9a2.5 2 0 0 0-2.5-1.5c-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2A2.5 2 0 0 1 9.5 15M12 6v1.5M12 16.5V18" /></svg>,
};

function Shell({ children, merchant }: { children: React.ReactNode; merchant?: string }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-md items-center gap-3 px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-bg" aria-hidden>{merchant?.[0] ?? '·'}</span>
          <div className="leading-tight"><p className="font-bold">{merchant ?? 'Your order'}</p><p className="text-xs text-mute">A message about your order</p></div>
        </div>
      </header>
      <main className="mx-auto max-w-md px-4 pb-16 pt-6">{children}</main>
    </div>
  );
}
