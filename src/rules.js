import { daysBetween } from './clock.js';

// Deterministic risk rules (FR4). No model decides whether an order is a candidate.
export const RULE_PRIORITY = ['returned', 'delivery_failed', 'delivery_delayed', 'promised_date_passed', 'no_scan'];

export function evaluateShipment({ order, shipment, now, noScanDays = 3 }) {
  const hits = [];
  const { status } = shipment;
  if (status === 'DELIVERED') return hits;

  if (status === 'RETURNED') hits.push({ rule: 'returned', detail: 'Carrier reports the parcel was returned to sender.' });
  if (status === 'FAILED_ATTEMPT') hits.push({ rule: 'delivery_failed', detail: 'Carrier reports a failed delivery attempt.' });
  if (status === 'DELAYED') hits.push({ rule: 'delivery_delayed', detail: 'Carrier reports a delivery delay.' });

  const promisedEnd = Date.parse(`${order.promised_date}T23:59:59Z`);
  if (status !== 'RETURNED' && now.getTime() > promisedEnd) {
    hits.push({ rule: 'promised_date_passed', detail: `Promised date ${order.promised_date} has passed without delivery.` });
  }

  if (status !== 'RETURNED') {
    const since = new Date(shipment.last_event_at || shipment.label_created_at);
    const idle = daysBetween(now, since);
    if (idle >= noScanDays) {
      hits.push({ rule: 'no_scan', detail: `No carrier scan for ${Math.floor(idle)} days (threshold ${noScanDays}).` });
    }
  }
  return hits.sort((a, b) => RULE_PRIORITY.indexOf(a.rule) - RULE_PRIORITY.indexOf(b.rule));
}
