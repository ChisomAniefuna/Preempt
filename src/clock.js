// A clock the simulator can advance, so the demo can play out days of shipping in seconds.
export function createClock() {
  let offsetMs = 0;
  return {
    now: () => new Date(Date.now() + offsetMs),
    iso: () => new Date(Date.now() + offsetMs).toISOString(),
    advanceDays(n) {
      offsetMs += n * 86_400_000;
    },
  };
}

export const daysBetween = (later, earlier) => (later - earlier) / 86_400_000;
export const addDays = (date, n) => new Date(date.getTime() + n * 86_400_000);
export const ymd = (date) => date.toISOString().slice(0, 10);
