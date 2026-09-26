'use strict';

// Service + database integration tests (in-memory DB, stubbed scraper I/O).
// These prove the core assignment guarantees:
//   - invalid/duplicate tracking is rejected safely
//   - failed scrapes persist attempts but NEVER fake history
//   - retry-then-success yields 3 attempts + exactly 1 history row
//   - STRUCTURE_CHANGED / PRICE_DROP events fire correctly

// NEVER touch a real database from tests: clear DATABASE_URL before anything
// requires the db layer (dotenv won't override an already-set variable).
process.env.DATABASE_URL = '';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../src/config/database');
const { trackProduct } = require('../src/services/tracking.service');
const { runSingle } = require('../src/services/scrape.service');

let n = 0;
async function freshTracked(db, optionValue = '256GB') {
  n += 1;
  const p = await db.upsertProduct({
    storeProductId: `test-${n}`, name: `Test Product ${n}`,
    productUrl: `https://demo.inelabteamdev.com/item/test-${n}`, description: '',
  });
  const o = await db.upsertOption({ productId: p.id, optionName: 'Storage', optionValue, storeOptionId: 'o1' });
  const { row } = await db.createTracked({ productId: p.id, optionId: o.id });
  return row;
}

function stubIo({ manifestClasses = { priceValue: 'pv' }, failTimes = 0, price = 69999, stock = true, code = 'HTTP_TIMEOUT' } = {}) {
  let calls = 0;
  return {
    fetchItemFn: async () => ({ ok: true, item: { options: [{ id: 'o1', label: '256GB' }] }, durationMs: 1 }),
    fetchManifestFn: async () => ({ ok: true, manifest: { classes: manifestClasses, order: [], priceTag: 'span', priceCarrier: 'plain', revision: 1 }, durationMs: 1 }),
    scrapeFn: async ({ storeProductId }) => {
      calls += 1;
      if (calls <= failTimes) throw Object.assign(new Error('simulated timeout'), { code });
      return {
        success: true,
        data: { storeProductId: String(storeProductId), productName: 'Test', optionName: 'Storage', optionValue: '256GB', price, stock, sourceUrl: 'http://x' },
        strategy: 'http', durationMs: 5,
      };
    },
  };
}

test('tracking rejects unknown product', async () => {
  const db = await getDb();
  await assert.rejects(() => trackProduct('nope', 'nope', db), (e) => e.code === 'PRODUCT_NOT_FOUND' && e.status === 404);
});

test('tracking rejects option from another product (400)', async () => {
  const db = await getDb();
  const t = await freshTracked(db);
  await assert.rejects(() => trackProduct(t.productId, 'wrong-option-id', db), (e) => e.code === 'OPTION_NOT_FOUND' && e.status === 400);
});

test('duplicate tracking does not create a second row', async () => {
  const db = await getDb();
  const t = await freshTracked(db, '512GB');
  const again = await trackProduct(t.productId, t.optionId, db);
  assert.equal(again.created, false);
  assert.equal(again.row.id, t.id);
});

test('failed scrape: 3 attempts persisted, 0 history', async () => {
  const db = await getDb();
  const t = await freshTracked(db);
  const r = await runSingle(t.id, db, { io: stubIo({ failTimes: 99 }) });
  assert.equal(r.success, false);
  assert.equal(r.attempts, 3);
  const attempts = await db.getAttempts(t.id);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((a) => a.status).sort(), ['failed', 'retried', 'retried']);
  assert.equal(attempts.every((a) => a.price === null && a.stock === null), true); // no fake values
  assert.equal((await db.getHistory(t.id)).length, 0); // honest: nothing stored
});

test('successful scrape: 1 attempt + 1 history', async () => {
  const db = await getDb();
  const t = await freshTracked(db);
  const r = await runSingle(t.id, db, { io: stubIo({ price: 69999, stock: true }) });
  assert.equal(r.success, true);
  const attempts = await db.getAttempts(t.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'success');
  const history = await db.getHistory(t.id);
  assert.equal(history.length, 1);
  assert.equal(Number(history[0].price), 69999);
});

test('retry-then-success: 3 attempts, exactly 1 history', async () => {
  const db = await getDb();
  const t = await freshTracked(db);
  const r = await runSingle(t.id, db, { io: stubIo({ failTimes: 2, price: 65000 }) });
  assert.equal(r.success, true);
  assert.equal((await db.getAttempts(t.id)).length, 3);
  assert.equal((await db.getHistory(t.id)).length, 1);
});

test('STRUCTURE_CHANGED fires only when fingerprint changes', async () => {
  const db = await getDb();
  const t = await freshTracked(db);
  const changedEvents = () => db.state.events.filter((e) => e.eventType === 'STRUCTURE_CHANGED' && e.trackedProductId === t.id);
  await runSingle(t.id, db, { io: stubIo({ manifestClasses: { priceValue: 'aaa' } }) });
  await runSingle(t.id, db, { io: stubIo({ manifestClasses: { priceValue: 'aaa' } }) });
  const before = changedEvents().length;
  await runSingle(t.id, db, { io: stubIo({ manifestClasses: { priceValue: 'bbb' } }) });
  const changed = changedEvents();
  assert.equal(changed.length, before + 1);
  assert.equal(changed[changed.length - 1].metadata.current !== changed[changed.length - 1].metadata.previous, true);
});

test('PRICE_DROP fires when price falls', async () => {
  const db = await getDb();
  const t = await freshTracked(db);
  await runSingle(t.id, db, { io: stubIo({ price: 70000 }) });
  await runSingle(t.id, db, { io: stubIo({ price: 69000 }) });
  const drops = db.state.events.filter((e) => e.eventType === 'PRICE_DROP' && e.trackedProductId === t.id);
  assert.equal(drops.length, 1);
  assert.deepEqual({ from: drops[0].metadata.from, to: drops[0].metadata.to }, { from: 70000, to: 69000 });
});

test('cron lock excludes overlapping runs', async () => {
  const db = await getDb();
  let releaseFirst;
  const first = db.withCronLock(() => new Promise((res) => { releaseFirst = res; }));
  await new Promise((r) => setTimeout(r, 20)); // let the first holder acquire
  const second = await db.withCronLock(async () => 'second');
  assert.equal(second.acquired, false); // overlapping run refused
  releaseFirst('first');
  assert.equal((await first).acquired, true);
  const third = await db.withCronLock(async () => 'third');
  assert.equal(third.acquired, true); // lock released after first finished
  assert.equal(third.result, 'third');
});
