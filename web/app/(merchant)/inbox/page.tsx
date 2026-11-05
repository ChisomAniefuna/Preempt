import InboxList from '@/components/InboxList';
import { PageTitle } from '@/components/ui';
import { fetchInbox } from '@/lib/queries';
import { createClient } from '@/lib/supabase/server';

export default async function InboxPage() {
  const rows = await fetchInbox(await createClient());
  return (
    <>
      <PageTitle sub="Orders the agent caught before the buyer complained. New ones appear live.">At-risk orders</PageTitle>
      <InboxList initial={rows} />
    </>
  );
}
