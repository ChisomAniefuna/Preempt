-- Fix the audit trigger's search path and restrict the RLS helper to signed-in callers.
alter function public.audit_events_immutable() set search_path = public;
revoke execute on function public.my_merchant_ids() from public, anon;
grant execute on function public.my_merchant_ids() to authenticated, service_role;
