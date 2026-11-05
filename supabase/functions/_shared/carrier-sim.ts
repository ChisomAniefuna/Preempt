// Simulated carrier feed: a scripted timeline per scenario. Statuses reuse PayPal's tracker status names.
export type Scenario = 'on_time' | 'stall' | 'failed' | 'returned';
export const SCENARIOS: Scenario[] = ['on_time', 'stall', 'failed', 'returned'];

interface Step { day: number; status: string; location: string }

const TIMELINES: Record<Scenario, Step[]> = {
  on_time: [
    { day: 0, status: 'SHIPMENT_CREATED', location: 'Austin, TX' }, { day: 1, status: 'IN_TRANSIT', location: 'Dallas, TX' },
    { day: 2, status: 'IN_TRANSIT', location: 'Memphis hub' }, { day: 4, status: 'DELIVERED', location: 'Destination' },
  ],
  stall: [ // the feed simply stops after day 2
    { day: 0, status: 'SHIPMENT_CREATED', location: 'Austin, TX' }, { day: 1, status: 'IN_TRANSIT', location: 'Dallas, TX' },
    { day: 2, status: 'IN_TRANSIT', location: 'Memphis hub' },
  ],
  failed: [
    { day: 0, status: 'SHIPMENT_CREATED', location: 'Austin, TX' }, { day: 1, status: 'IN_TRANSIT', location: 'Dallas, TX' },
    { day: 2, status: 'IN_TRANSIT', location: 'Memphis hub' }, { day: 4, status: 'DELIVERY_FAILED', location: 'Destination' },
  ],
  returned: [
    { day: 0, status: 'SHIPMENT_CREATED', location: 'Austin, TX' }, { day: 1, status: 'IN_TRANSIT', location: 'Dallas, TX' },
    { day: 2, status: 'IN_TRANSIT', location: 'Memphis hub' }, { day: 4, status: 'DELIVERY_FAILED', location: 'Destination' },
    { day: 6, status: 'RETURNED', location: 'Austin, TX' },
  ],
};

/** Days after shipping that the promised date is set to, per scenario. */
export const PROMISE_DAYS: Record<Scenario, number> = { on_time: 6, stall: 5, failed: 5, returned: 5 };

export interface FeedEvent { id: string; day: number; status: string; location: string; at: string }

/** Events that have happened by `now`, given when the shipment started. Ids are stable for dedupe. */
export function eventsUpTo(scenario: Scenario, trackingNumber: string, startedAt: string, now: Date): FeedEvent[] {
  const start = Date.parse(startedAt);
  const elapsedDays = (now.getTime() - start) / 86_400_000;
  return TIMELINES[scenario]
    .filter((s) => s.day <= elapsedDays)
    .map((s) => ({ id: `${trackingNumber}-${s.day}-${s.status}`, ...s, at: new Date(start + s.day * 86_400_000).toISOString() }));
}
