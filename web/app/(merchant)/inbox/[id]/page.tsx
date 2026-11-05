import { notFound } from 'next/navigation';
import IncidentView from '@/components/IncidentView';
import { fetchIncident } from '@/lib/queries';
import { createClient } from '@/lib/supabase/server';

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { incident, audit } = await fetchIncident(await createClient(), id).catch(() => ({ incident: null, audit: [] }));
  if (!incident) notFound();
  return <IncidentView initial={incident} initialAudit={audit} />;
}
