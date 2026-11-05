'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Banner, Logo, Spinner } from '@/components/ui';

const POINTS = [
  ['Catches it early', 'Stalled, failed or returned parcels are flagged days before the buyer complains.'],
  ['Fixes it fairly', 'The agent offers only what your policy allows. Code, not the model, enforces every limit.'],
  ['Shows its work', 'Every refund traces back to the signal that started it.'],
];

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithPassword({ email, password });
    if (error) { setError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message); setBusy(false); return; }
    router.replace('/inbox');
    router.refresh();
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="hidden flex-col justify-between bg-accent p-12 text-bg lg:flex">
        <div className="flex items-center gap-3 text-xl font-bold"><span className="rounded-[10px] bg-bg/15 p-1"><Logo size={30} /></span> Preempt</div>
        <div>
          <h2 className="max-w-md text-5xl font-bold leading-[1.05]">Fix the order before the buyer disputes it.</h2>
          <ul className="mt-10 space-y-5">
            {POINTS.map(([t, d]) => (
              <li key={t} className="flex gap-3"><span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg/20 text-xs" aria-hidden>✓</span><p className="max-w-md"><span className="font-semibold">{t}.</span> <span className="opacity-80">{d}</span></p></li>
            ))}
          </ul>
        </div>
        <p className="text-sm opacity-70">Runs on the PayPal sandbox. No real money moves.</p>
      </aside>

      <main className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 text-2xl font-bold lg:hidden"><Logo size={36} /> Preempt</div>
          <h1 className="text-3xl font-bold">Welcome back</h1>
          <p className="mb-7 mt-1 text-mute">Sign in to see which orders need you.</p>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" type="email" autoComplete="username" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label htmlFor="password" className="label">Password</label>
              <input id="password" type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <Banner title={error} />}
            <button className="btn w-full" disabled={busy}>{busy ? <Spinner label="Signing in" /> : 'Sign in'}</button>
          </form>
          <p className="mt-6 text-center text-sm text-mute">Judges: the demo login is on the Devpost submission form.</p>
        </div>
      </main>
    </div>
  );
}
