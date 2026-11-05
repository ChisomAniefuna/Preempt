import { createApp } from '../src/app.js';
import { ymd, addDays } from '../src/clock.js';

export const mkApp = () => createApp({ dbPath: ':memory:', anthropicKey: '', baseUrl: 'http://test', paypal: { mode: 'mock' } });

export async function seed(app, { n = 1, amountCents = 6000, timeline = [], ship = true } = {}) {
  const now = app.clock.now();
  const order = app.engine.ingestOrder({ merchantOrderId: `T-${n}`, captureId: `CAP-${n}`, buyerEmail: 'b@example.com', buyerName: 'Sam', amountCents, promisedDate: ymd(addDays(now, 5)) });
  if (ship) {
    await app.engine.shipOrder(order.id, { trackingNumber: `TRK${n}` });
    app.carrier.loadTimeline(`TRK${n}`, timeline.map((e) => ({ ...e, occursAt: addDays(now, e.day).toISOString() })));
  }
  return order;
}
