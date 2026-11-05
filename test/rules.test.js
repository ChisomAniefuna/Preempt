import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateShipment } from '../src/rules.js';

const now = new Date('2026-11-10T12:00:00Z');
const order = (promised) => ({ promised_date: promised });
const ship = (o) => ({ status: 'IN_TRANSIT', label_created_at: '2026-11-09T12:00:00Z', last_event_at: '2026-11-10T08:00:00Z', ...o });
const rules = (o, s) => evaluateShipment({ order: order(o), shipment: ship(s), now }).map((h) => h.rule);

test('healthy shipment fires nothing', () => assert.deepEqual(rules('2026-11-15', {}), []));
test('no_scan fires only no_scan', () => assert.deepEqual(rules('2026-11-15', { status: 'LABEL_CREATED', last_event_at: null, label_created_at: '2026-11-05T12:00:00Z' }), ['no_scan']));
test('delivery_delayed fires only itself', () => assert.deepEqual(rules('2026-11-15', { status: 'DELAYED' }), ['delivery_delayed']));
test('delivery_failed fires only itself', () => assert.deepEqual(rules('2026-11-15', { status: 'FAILED_ATTEMPT' }), ['delivery_failed']));
test('returned fires only itself', () => assert.deepEqual(rules('2026-11-15', { status: 'RETURNED' }), ['returned']));
test('promised_date_passed fires only itself', () => assert.deepEqual(rules('2026-11-09', {}), ['promised_date_passed']));
test('delivered never fires', () => assert.deepEqual(rules('2026-11-01', { status: 'DELIVERED' }), []));
