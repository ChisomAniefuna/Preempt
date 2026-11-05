import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type Actor = 'RULE' | 'AGENT' | 'VALIDATOR' | 'MERCHANT' | 'BUYER' | 'EXECUTOR' | 'WEBHOOK' | 'POLICY' | 'SYSTEM';
export interface AuditEntry { incidentId?: string | null; actor: Actor; kind: string; input?: unknown; output?: unknown }
export type AuditFn = (e: AuditEntry) => Promise<void>;

/** Append-only audit log (the table rejects updates and deletes). Never throws: logging must not break the flow. */
export const auditTo = (admin: SupabaseClient): AuditFn => async (e) => {
  const { error } = await admin.from('audit_events').insert({ incident_id: e.incidentId ?? null, actor: e.actor, kind: e.kind, input: e.input ?? null, output: e.output ?? null });
  if (error) console.error('audit insert failed', error.message);
};
