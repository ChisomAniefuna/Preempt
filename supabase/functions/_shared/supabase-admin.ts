import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { env } from './env.ts';

/** Service-role client. Server side only: it bypasses row level security. */
export const adminClient = (): SupabaseClient =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

/** A client that acts as the calling merchant, so row level security applies to every read. */
export const userClient = (authHeader: string): SupabaseClient =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
