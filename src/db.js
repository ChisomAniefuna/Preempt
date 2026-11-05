import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  merchant_order_id TEXT NOT NULL,
  paypal_order_id TEXT,
  capture_id TEXT NOT NULL UNIQUE,
  buyer_email TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  promised_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  tracking_number TEXT NOT NULL UNIQUE,
  carrier TEXT NOT NULL,
  label_created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'LABEL_CREATED',
  last_event_at TEXT,
  last_event_text TEXT,
  paypal_tracking_id TEXT,
  superseded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS carrier_events (
  id INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  tracking_number TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT,
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_timelines (
  id INTEGER PRIMARY KEY,
  tracking_number TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT,
  occurs_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  shipment_id INTEGER NOT NULL REFERENCES shipments(id),
  rule TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  risk_level TEXT,
  issue TEXT,
  reason TEXT,
  state TEXT NOT NULL,
  buyer_token TEXT NOT NULL UNIQUE,
  offers_json TEXT,
  chosen_json TEXT,
  approval_token TEXT,
  approval_used INTEGER NOT NULL DEFAULT 0,
  resolution_json TEXT,
  flagged_at TEXT NOT NULL,
  contacted_at TEXT,
  chosen_at TEXT,
  decided_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  incident_id INTEGER,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  incident_id INTEGER NOT NULL UNIQUE REFERENCES incidents(id),
  capture_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paypal_refund_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  paypal_dispute_id TEXT NOT NULL UNIQUE,
  capture_id TEXT,
  incident_id INTEGER,
  status TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS paypal_requests (
  request_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_incident_per_order ON incidents(order_id)
  WHERE state IN ('flagged','offered','awaiting_merchant','escalated','executing');
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export const q = {
  get: (db, sql, ...p) => db.prepare(sql).get(...p),
  all: (db, sql, ...p) => db.prepare(sql).all(...p),
  run: (db, sql, ...p) => db.prepare(sql).run(...p),
};
