'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Logo } from './ui';

const LINKS = [['/inbox', 'Inbox'], ['/dashboard', 'Outcomes'], ['/policy', 'Policy'], ['/demo', 'Demo']] as const;

export default function Nav({ merchantName }: { merchantName: string }) {
  const path = usePathname();
  const router = useRouter();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-card/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5 sm:px-6">
        <Link href="/inbox" className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
          <Logo /> Preempt
        </Link>
        <nav aria-label="Main" className="flex flex-wrap gap-1">
          {LINKS.map(([href, label]) => {
            const active = path.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition ${active ? 'bg-accent-bg text-accent' : 'text-mute hover:bg-line/50 hover:text-ink'}`}>
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm">
          {merchantName && <span className="hidden items-center gap-2 rounded-full border border-line bg-bg py-1 pl-1 pr-3 sm:flex"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-bold text-bg">{merchantName[0]}</span>{merchantName}</span>}
          <button className="rounded-lg px-3 py-2 font-medium text-mute hover:bg-line/50 hover:text-ink" onClick={async () => { await createClient().auth.signOut(); router.replace('/login'); router.refresh(); }}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
