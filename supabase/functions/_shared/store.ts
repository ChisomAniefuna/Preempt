import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { ActionContext, ExecutorStore } from './executor.ts';

/** Supabase-backed store for the executor. Uses the service role; callers must already have authorised the action. */
export function createStore(admin: SupabaseClient): ExecutorStore {
  return {
    async loadContext(actionId) {
      const { data: action } = await admin.from('actions').select('*').eq('id', actionId).maybeSingle();
      if (!action || action.status !== 'PENDING') return null;
      const { data: offer } = await admin.from('offers').select('id, incident_id, buyer_choice').eq('id', action.offer_id).single();
      const { data: incident } = await admin.from('incidents').select('id, state, dispute_id, order_id').eq('id', offer!.incident_id).single();
      const { data: order } = await admin.from('orders').select('*').eq('id', incident!.order_id).single();
      const { data: policy } = await admin.from('policies').select('*').eq('merchant_id', order!.merchant_id).single();
      return {
        action, choice: offer!.buyer_choice, incident: { id: incident!.id, state: incident!.state, dispute_id: incident!.dispute_id },
        order, policy,
      } as ActionContext;
    },
    async completeRefund(actionId, refId) {
      const { data, error } = await admin.rpc('complete_refund', { p_action: actionId, p_ref: refId });
      if (error) throw new Error(`complete_refund failed: ${error.message}`);
      return Boolean(data);
    },
    async completeNewEta(actionId, orderId, promisedBy) {
      await must(admin.from('orders').update({ promised_by: promisedBy }).eq('id', orderId));
      await finish(admin, actionId, null);
    },
    async completeReship(actionId, a) {
      await must(admin.from('shipments').upsert({ order_id: a.orderId, carrier: a.carrier, tracking_number: a.trackingNumber, paypal_tracker_id: a.trackerId, sim_scenario: 'on_time', sim_started_at: new Date().toISOString() }, { onConflict: 'order_id,tracking_number' }));
      await must(admin.from('orders').update({ promised_by: a.promisedBy }).eq('id', a.orderId));
      await finish(admin, actionId, a.trackerId);
    },
    async failAction(actionId, incidentId, error) {
      await must(admin.from('actions').update({ status: 'FAILED', error, claimed_until: null }).eq('id', actionId));
      await must(admin.from('incidents').update({ state: 'ACTION_FAILED' }).eq('id', incidentId).eq('state', 'EXECUTING'));
    },
  };
}

async function finish(admin: SupabaseClient, actionId: string, ref: string | null) {
  const { data: a } = await admin.from('actions').update({ status: 'COMPLETED', paypal_ref_id: ref, error: null, claimed_until: null }).eq('id', actionId).select('offer_id').single();
  const { data: o } = await admin.from('offers').select('incident_id').eq('id', a!.offer_id).single();
  await must(admin.from('incidents').update({ state: 'RESOLVED', closed_at: new Date().toISOString() }).eq('id', o!.incident_id).in('state', ['EXECUTING', 'ACTION_FAILED']));
}

async function must(q: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await q;
  if (error) throw new Error(error.message);
}
