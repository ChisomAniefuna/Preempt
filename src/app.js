import { openDb } from './db.js';
import { createClock } from './clock.js';
import { createAudit } from './audit.js';
import { createPayPal } from './paypal.js';
import { createSimCarrier } from './carrier.js';
import { createAgent } from './agent.js';
import { createEngine } from './engine.js';
import { config as defaultConfig } from './config.js';

export function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides };
  const db = openDb(config.dbPath);
  const clock = createClock();
  const audit = createAudit(db, clock);
  const paypal = createPayPal({ db, config: config.paypal });
  const carrier = createSimCarrier(db);
  const agent = createAgent({ config, tools: paypal.read }); // read-only tools only
  const engine = createEngine({ db, clock, audit, paypal, carrier, agent, config });
  return { config, db, clock, audit, paypal, carrier, agent, engine };
}
