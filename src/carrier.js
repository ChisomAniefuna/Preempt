import { q } from './db.js';

/**
 * Simulated carrier feed (a JSON timeline per tracking number). Events become visible once the
 * (simulated) clock passes their `occursAt`, so a scripted timeline plays out as days are advanced.
 */
export function createSimCarrier(db) {
  return {
    loadTimeline(trackingNumber, events) {
      for (const e of events) {
        q.run(db, 'INSERT INTO sim_timelines (tracking_number, status, text, occurs_at) VALUES (?, ?, ?, ?)', trackingNumber, e.status, e.text || '', e.occursAt);
      }
    },
    fetchEvents(trackingNumbers, now) {
      if (trackingNumbers.length === 0) return [];
      const marks = trackingNumbers.map(() => '?').join(',');
      return q
        .all(db, `SELECT tracking_number, status, text, occurs_at FROM sim_timelines WHERE tracking_number IN (${marks}) AND occurs_at <= ? ORDER BY occurs_at, id`, ...trackingNumbers, now.toISOString())
        .map((r) => ({ trackingNumber: r.tracking_number, status: r.status, text: r.text, occurredAt: r.occurs_at }));
    },
  };
}
