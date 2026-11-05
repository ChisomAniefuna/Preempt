import Nav from '@/components/Nav';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function DemoLayout({ children }: { children: React.ReactNode }) {
  const { data: merchant } = await (await createClient()).from('merchants').select('name').maybeSingle();
  return (<><Nav merchantName={merchant?.name ?? ''} /><main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main></>);
}
