import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditEvent, DashboardTotals, Incident, Policy } from './types';

export async function fetchInbox(sb: SupabaseClient): Promise<Incident[]> {
  const { data, error } = await sb.from('incidents').select('*, orders(*, shipments(*))').order('opened_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as Incident[];
}

export async function fetchIncident(sb: SupabaseClient, id: string): Promise<{ incident: Incident | null; audit: AuditEvent[] }> {
  const { data, error } = await sb.from('incidents').select('*, orders(*, shipments(*)), offers(*, actions(*))').eq('id', id).maybeSingle();
  if (error) throw error;
  const { data: audit, error: e2 } = await sb.from('audit_events').select('*').eq('incident_id', id).order('id');
  if (e2) throw e2;
  return { incident: (data as unknown as Incident) ?? null, audit: (audit ?? []) as AuditEvent[] };
}

export async function fetchPolicy(sb: SupabaseClient): Promise<Policy | null> {
  const { data, error } = await sb.from('policies').select('*').maybeSingle();
  if (error) throw error;
  return data as Policy | null;
}

export async function fetchDashboard(sb: SupabaseClient): Promise<DashboardTotals | null> {
  const { data, error } = await sb.from('dashboard_totals').select('*').maybeSingle();
  if (error) throw error;
  return data as DashboardTotals | null;
}
