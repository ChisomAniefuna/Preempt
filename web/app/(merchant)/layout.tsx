import Nav from '@/components/Nav';
import { createClient } from '@/lib/supabase/server';
import { Banner } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function MerchantLayout({ children }: { children: React.ReactNode }) {
  const sb = await createClient();
  const { data: merchant } = await sb.from('merchants').select('name').maybeSingle();
  return (
    <>
      <Nav merchantName={merchant?.name ?? ''} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {merchant ? children : (
          <Banner tone="warn" title="No merchant is linked to this login">
            Run supabase/seed.sql after creating the demo user, or insert a row in merchants for this account.
          </Banner>
        )}
      </main>
    </>
  );
}
