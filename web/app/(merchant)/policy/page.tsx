import PolicyForm from '@/components/PolicyForm';
import { Banner, PageTitle } from '@/components/ui';
import { fetchPolicy } from '@/lib/queries';
import { createClient } from '@/lib/supabase/server';

export default async function PolicyPage() {
  const policy = await fetchPolicy(await createClient());
  return (
    <>
      <PageTitle sub="The agent can only propose what is allowed here. A validator checks every offer before the buyer sees it.">Policy</PageTitle>
      {policy ? <PolicyForm initial={policy} /> : <Banner tone="warn" title="No policy found for this merchant">Run supabase/seed.sql to create the default policy.</Banner>}
    </>
  );
}
