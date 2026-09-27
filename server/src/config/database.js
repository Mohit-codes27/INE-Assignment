'use strict';

// Database layer.
// Uses Supabase Postgres via `pg` when DATABASE_URL is set.
// Falls back to an in-memory store so the app runs locally with zero setup.
// Both implement the same async interface used by services.

const { randomUUID } = require('crypto');
const logger = require('../utils/logger');

function nowIso() {
  return new Date().toISOString();
}

// Advisory-lock key for the cron guard (arbitrary 64-bit id, namespaced to
// this app so it can never collide with another app's locks on shared Pg).
const CRON_LOCK_KEY = 910271845;

// ---------------- In-memory fallback ----------------
function createMemoryDb() {
  const state = {
    products: new Map(),        // id -> row
    productsByStoreId: new Map(),
    options: new Map(),         // id -> row
    tracked: new Map(),         // id -> row
    history: [],                // price_history rows
    attempts: [],               // scrape_attempts rows
    events: [],
    runs: [],
    fingerprints: new Map(),  // trackedProductId -> structure fingerprint
  };

  // Cron overlap flag. Node is single-threaded and the check-and-set below
  // has no await between test and set, so it is race-free here (unlike the
  // old pg SELECT-then-INSERT, which could race across connections).
  let cronLocked = false;

  return {
    kind: 'memory',
    state,
    async init() { logger.info('db using in-memory store (no DATABASE_URL)'); },
    async close() {},
    // -- products --
    async upsertProduct({ storeProductId, name, productUrl, description, imageUrl }) {
      let row = state.productsByStoreId.get(String(storeProductId));
      if (row) {
        Object.assign(row, { name, productUrl, description, imageUrl, updatedAt: nowIso() });
        return row;
      }
      row = { id: randomUUID(), storeProductId: String(storeProductId), name, productUrl, description: description || null, imageUrl: imageUrl || null, createdAt: nowIso(), updatedAt: nowIso() };
      state.products.set(row.id, row);
      state.productsByStoreId.set(row.storeProductId, row);
      return row;
    },
    async upsertOption({ productId, optionName, optionValue, storeOptionId }) {
      for (const o of state.options.values()) {
        if (o.productId === productId && o.optionValue === optionValue) return o;
      }
      const row = { id: randomUUID(), productId, optionName, optionValue, storeOptionId: storeOptionId || null, createdAt: nowIso(), updatedAt: nowIso() };
      state.options.set(row.id, row);
      return row;
    },
    async getProductWithOptions(productId) {
      const p = state.products.get(productId) || [...state.products.values()].find((x) => x.storeProductId === String(productId));
      if (!p) return null;
      const options = [...state.options.values()].filter((o) => o.productId === p.id);
      return { ...p, options };
    },
    // -- tracked --
    async createTracked({ productId, optionId, intervalMinutes }) {
      for (const t of state.tracked.values()) {
        if (t.productId === productId && t.optionId === optionId) return { row: t, created: false };
      }
      const row = { id: randomUUID(), productId, optionId, active: true, scrapeIntervalMinutes: intervalMinutes || 120, lastScrapedAt: null, lastSuccessAt: null, createdAt: nowIso(), updatedAt: nowIso() };
      state.tracked.set(row.id, row);
      return { row, created: true };
    },
    async listTracked() {
      return [...state.tracked.values()].map((t) => enrichTracked(state, t)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async getTracked(id) {
      const t = state.tracked.get(id);
      return t ? enrichTracked(state, t) : null;
    },
    async touchTracked(id, { success }) {
      const t = state.tracked.get(id);
      if (!t) return;
      t.lastScrapedAt = nowIso();
      if (success) t.lastSuccessAt = t.lastScrapedAt;
      t.updatedAt = nowIso();
    },
    async setTrackedActive(id, active) {
      const t = state.tracked.get(id);
      if (t) { t.active = active; t.updatedAt = nowIso(); }
      return t ? enrichTracked(state, t) : null;
    },
    // -- history / attempts --
    async insertAttempt(a) {
      const row = { id: randomUUID(), createdAt: nowIso(), ...a };
      state.attempts.push(row);
      return row;
    },
    async insertHistory(h) {
      const row = { id: randomUUID(), ...h };
      state.history.push(row);
      return row;
    },
    async getHistory(trackedId, { limit } = {}) {
      return state.history.filter((h) => h.trackedProductId === trackedId)
        .sort((a, b) => (a.scrapedAt < b.scrapedAt ? 1 : -1))
        .slice(0, limit || 500);
    },
    async getAttempts(trackedId, { limit } = {}) {
      return state.attempts.filter((a) => a.trackedProductId === trackedId)
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
        .slice(0, limit || 200);
    },
    async allAttemptsForExport() {
      return state.attempts.map((a) => {
        const t = state.tracked.get(a.trackedProductId);
        const p = t && state.products.get(t.productId);
        const o = t && state.options.get(t.optionId);
        return { ...a, productName: p ? p.name : '', storeProductId: p ? p.storeProductId : '', optionLabel: o ? `${o.optionName}:${o.optionValue}` : '' };
      }).sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
    },
    async insertEvent(e) {
      const row = { id: randomUUID(), createdAt: nowIso(), ...e };
      state.events.push(row);
      return row;
    },
    async lastSuccessfulPrice(trackedId) {
      const h = state.history.filter((x) => x.trackedProductId === trackedId).sort((a, b) => (a.scrapedAt < b.scrapedAt ? 1 : -1));
      return h.length > 1 ? h[1] : null; // previous (before latest)
    },
    async latestHistory(trackedId) {
      const h = state.history.filter((x) => x.trackedProductId === trackedId).sort((a, b) => (a.scrapedAt < b.scrapedAt ? 1 : -1));
      return h[0] || null;
    },
    // -- structure fingerprints (STRUCTURE_CHANGED bonus) --
    async getStructureFingerprint(trackedId) {
      return state.fingerprints.get(trackedId) || null;
    },
    async setStructureFingerprint(trackedId, fp) {
      state.fingerprints.set(trackedId, fp);
    },
    // -- atomic persistence of one finished scrape --
    // One synchronous mutation block: attempts + optional history + tracking
    // touch + events + fingerprint land together, so a mid-save crash can't
    // leave partial state (e.g. history without attempts, or a fingerprint
    // updated while its scrape's history was lost). Single-threaded JS makes
    // this atomic here; the pg backend below uses a real transaction.
    async saveScrapeOutcome({ trackedId, attempts, history, success, events, fingerprint }) {
      for (const a of attempts || []) state.attempts.push({ id: randomUUID(), createdAt: nowIso(), ...a });
      if (history) state.history.push({ id: randomUUID(), ...history });
      const t = state.tracked.get(trackedId);
      if (t) {
        t.lastScrapedAt = nowIso();
        if (success) t.lastSuccessAt = t.lastScrapedAt;
        t.updatedAt = nowIso();
      }
      for (const e of events || []) state.events.push({ id: randomUUID(), createdAt: nowIso(), trackedProductId: trackedId, ...e });
      if (fingerprint) state.fingerprints.set(trackedId, fingerprint);
    },
    // -- runs (overlap lock) --
    // Memory backend is single-threaded: synchronous check-and-set, no race.
    async withCronLock(fn) {
      if (cronLocked) return { acquired: false };
      cronLocked = true;
      try {
        return { acquired: true, result: await fn() };
      } finally {
        cronLocked = false;
      }
    },
    async tryStartRun(trigger) {
      const open = state.runs.find((r) => !r.completedAt);
      if (open && Date.now() - new Date(open.startedAt).getTime() < 15 * 60 * 1000) return null;
      const run = { id: randomUUID(), startedAt: nowIso(), completedAt: null, status: 'running', trigger };
      state.runs.push(run);
      return run;
    },
    async finishRun(id, status) {
      const r = state.runs.find((x) => x.id === id);
      if (r) { r.completedAt = nowIso(); r.status = status; }
    },
    async listRuns(limit = 20) {
      return [...state.runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
    },
  };
}

function enrichTracked(state, t) {
  const p = state.products.get(t.productId);
  const o = state.options.get(t.optionId);
  return { ...t, product: p || null, option: o || null };
}

// ---------------- Postgres (Supabase) ----------------
function createPgDb(pgPool) {
  const q = (text, params) => pgPool.query(text, params);
  // Run fn(query) inside a real transaction on ONE dedicated connection.
  // (Advisory locks would also need a held connection; a transaction is the
  // simplest correct primitive here and keeps attempts+history+touch+events
  // atomic: all commit together or all roll back.)
  async function tx(fn) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client.query.bind(client));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return {
    kind: 'pg',
    async init() {
      await q(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";
        CREATE TABLE IF NOT EXISTS products (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), store_product_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, product_url TEXT NOT NULL, description TEXT, image_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS product_options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE, option_name TEXT NOT NULL, option_value TEXT NOT NULL, store_option_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(product_id, option_value));
        CREATE TABLE IF NOT EXISTS tracked_products (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE, option_id UUID NOT NULL REFERENCES product_options(id) ON DELETE CASCADE, active BOOLEAN NOT NULL DEFAULT TRUE, scrape_interval_minutes INTEGER NOT NULL DEFAULT 120, last_scraped_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(product_id, option_id));
        CREATE TABLE IF NOT EXISTS price_history (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tracked_product_id UUID NOT NULL REFERENCES tracked_products(id) ON DELETE CASCADE, price NUMERIC NOT NULL, stock BOOLEAN NOT NULL, scraped_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS scrape_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tracked_product_id UUID NOT NULL REFERENCES tracked_products(id) ON DELETE CASCADE, attempt_number INTEGER NOT NULL, status TEXT NOT NULL, strategy TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, duration_ms INTEGER, price NUMERIC, stock BOOLEAN, http_status INTEGER, error_code TEXT, error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS scraper_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tracked_product_id UUID REFERENCES tracked_products(id) ON DELETE CASCADE, event_type TEXT NOT NULL, message TEXT NOT NULL, metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS scrape_runs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'running', trigger TEXT);
        CREATE TABLE IF NOT EXISTS structure_fingerprints (tracked_product_id UUID PRIMARY KEY REFERENCES tracked_products(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
      logger.info('db postgres ready');
    },
    async close() { await pgPool.end(); },
    async upsertProduct(p) {
      const r = await q(`INSERT INTO products (store_product_id,name,product_url,description,image_url) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (store_product_id) DO UPDATE SET name=EXCLUDED.name, product_url=EXCLUDED.product_url, description=EXCLUDED.description, image_url=EXCLUDED.image_url, updated_at=now() RETURNING *`, [String(p.storeProductId), p.name, p.productUrl, p.description || null, p.imageUrl || null]);
      return mapProduct(r.rows[0]);
    },
    async upsertOption(o) {
      const r = await q(`INSERT INTO product_options (product_id,option_name,option_value,store_option_id) VALUES ($1,$2,$3,$4)
        ON CONFLICT (product_id, option_value) DO UPDATE SET option_name=EXCLUDED.option_name, store_option_id=EXCLUDED.store_option_id, updated_at=now() RETURNING *`, [o.productId, o.optionName, o.optionValue, o.storeOptionId || null]);
      return mapOption(r.rows[0]);
    },
    async getProductWithOptions(productId) {
      let r = await q('SELECT * FROM products WHERE id=$1', [productId]);
      if (!r.rows.length) r = await q('SELECT * FROM products WHERE store_product_id=$1', [String(productId)]);
      if (!r.rows.length) return null;
      const p = mapProduct(r.rows[0]);
      const o = await q('SELECT * FROM product_options WHERE product_id=$1', [p.id]);
      return { ...p, options: o.rows.map(mapOption) };
    },
    async createTracked({ productId, optionId, intervalMinutes }) {
      const r = await q(`INSERT INTO tracked_products (product_id,option_id,scrape_interval_minutes) VALUES ($1,$2,$3)
        ON CONFLICT (product_id, option_id) DO NOTHING RETURNING *`, [productId, optionId, intervalMinutes || 120]);
      if (!r.rows.length) {
        const ex = await q('SELECT * FROM tracked_products WHERE product_id=$1 AND option_id=$2', [productId, optionId]);
        return { row: await enrichPg(q, ex.rows[0]), created: false };
      }
      return { row: await enrichPg(q, r.rows[0]), created: true };
    },
    async listTracked() {
      const r = await q('SELECT * FROM tracked_products ORDER BY created_at DESC');
      return Promise.all(r.rows.map((x) => enrichPg(q, x)));
    },
    async getTracked(id) {
      const r = await q('SELECT * FROM tracked_products WHERE id=$1', [id]);
      return r.rows.length ? enrichPg(q, r.rows[0]) : null;
    },
    async touchTracked(id, { success }) {
      await q(success ? 'UPDATE tracked_products SET last_scraped_at=now(), last_success_at=now(), updated_at=now() WHERE id=$1'
        : 'UPDATE tracked_products SET last_scraped_at=now(), updated_at=now() WHERE id=$1', [id]);
    },
    async setTrackedActive(id, active) {
      const r = await q('UPDATE tracked_products SET active=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, active]);
      return r.rows.length ? enrichPg(q, r.rows[0]) : null;
    },
    async insertAttempt(a) {
      const r = await q(`INSERT INTO scrape_attempts (tracked_product_id,attempt_number,status,strategy,started_at,completed_at,duration_ms,price,stock,http_status,error_code,error_message)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [a.trackedProductId, a.attemptNumber, a.status, a.strategy, a.startedAt, a.completedAt || null, a.durationMs ?? null, a.price ?? null, a.stock ?? null, a.httpStatus ?? null, a.errorCode || null, a.errorMessage || null]);
      return r.rows[0];
    },
    async insertHistory(h) {
      const r = await q('INSERT INTO price_history (tracked_product_id,price,stock,scraped_at) VALUES ($1,$2,$3,$4) RETURNING *', [h.trackedProductId, h.price, h.stock, h.scrapedAt]);
      return r.rows[0];
    },
    async getHistory(trackedId, { limit } = {}) {
      const r = await q('SELECT * FROM price_history WHERE tracked_product_id=$1 ORDER BY scraped_at DESC LIMIT $2', [trackedId, limit || 500]);
      return r.rows;
    },
    async getAttempts(trackedId, { limit } = {}) {
      const r = await q('SELECT * FROM scrape_attempts WHERE tracked_product_id=$1 ORDER BY started_at DESC LIMIT $2', [trackedId, limit || 200]);
      return r.rows;
    },
    async allAttemptsForExport() {
      const r = await q(`SELECT a.*, p.name AS "productName", p.store_product_id AS "storeProductId", (o.option_name || ':' || o.option_value) AS "optionLabel"
        FROM scrape_attempts a LEFT JOIN tracked_products t ON t.id=a.tracked_product_id LEFT JOIN products p ON p.id=t.product_id LEFT JOIN product_options o ON o.id=t.option_id ORDER BY a.started_at ASC`);
      return r.rows;
    },
    async insertEvent(e) {
      const r = await q('INSERT INTO scraper_events (tracked_product_id,event_type,message,metadata) VALUES ($1,$2,$3,$4) RETURNING *', [e.trackedProductId || null, e.eventType, e.message, e.metadata ? JSON.stringify(e.metadata) : null]);
      return r.rows[0];
    },
    async lastSuccessfulPrice(trackedId) {
      const r = await q('SELECT * FROM price_history WHERE tracked_product_id=$1 ORDER BY scraped_at DESC LIMIT 2', [trackedId]);
      return r.rows[1] || null;
    },
    async latestHistory(trackedId) {
      const r = await q('SELECT * FROM price_history WHERE tracked_product_id=$1 ORDER BY scraped_at DESC LIMIT 1', [trackedId]);
      return r.rows[0] || null;
    },
    async getStructureFingerprint(trackedId) {
      const r = await q('SELECT fingerprint FROM structure_fingerprints WHERE tracked_product_id=$1', [trackedId]);
      return r.rows[0] ? r.rows[0].fingerprint : null;
    },
    async setStructureFingerprint(trackedId, fp) {
      await q(`INSERT INTO structure_fingerprints (tracked_product_id,fingerprint) VALUES ($1,$2)
        ON CONFLICT (tracked_product_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint, updated_at=now()`, [trackedId, fp]);
    },
    // Atomic persistence: attempts + optional history + tracking touch +
    // events + fingerprint commit together or roll back together — never
    // partial state (in particular the fingerprint can never advance while
    // its scrape's history is lost).
    async saveScrapeOutcome({ trackedId, attempts, history, success, events, fingerprint }) {
      await tx(async (xq) => {
        for (const a of attempts || []) {
          await xq(`INSERT INTO scrape_attempts (tracked_product_id,attempt_number,status,strategy,started_at,completed_at,duration_ms,price,stock,http_status,error_code,error_message)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [trackedId, a.attemptNumber, a.status, a.strategy, a.startedAt, a.completedAt || null, a.durationMs ?? null, a.price ?? null, a.stock ?? null, a.httpStatus ?? null, a.errorCode || null, a.errorMessage || null]);
        }
        if (history) {
          await xq('INSERT INTO price_history (tracked_product_id,price,stock,scraped_at) VALUES ($1,$2,$3,$4)',
            [trackedId, history.price, history.stock, history.scrapedAt]);
        }
        await xq(success
          ? 'UPDATE tracked_products SET last_scraped_at=now(), last_success_at=now(), updated_at=now() WHERE id=$1'
          : 'UPDATE tracked_products SET last_scraped_at=now(), updated_at=now() WHERE id=$1', [trackedId]);
        for (const e of events || []) {
          await xq('INSERT INTO scraper_events (tracked_product_id,event_type,message,metadata) VALUES ($1,$2,$3,$4)',
            [trackedId, e.eventType, e.message, e.metadata ? JSON.stringify(e.metadata) : null]);
        }
        if (fingerprint) {
          await xq(`INSERT INTO structure_fingerprints (tracked_product_id,fingerprint) VALUES ($1,$2)
            ON CONFLICT (tracked_product_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint, updated_at=now()`,
            [trackedId, fingerprint]);
        }
      });
    },
    // True mutual exclusion via a Postgres advisory lock held on ONE dedicated
    // connection for the whole run. pg_try_advisory_lock returns false
    // immediately if another backend holds it — no waiting, no race. The lock
    // is session-scoped, so it auto-releases if the process/connection dies
    // (then the next cron simply starts cleanly). Holding 1 of 10 pooled
    // connections for a few minutes every 2h is negligible.
    // (A plain INSERT...SELECT WHERE NOT EXISTS is NOT enough: under MVCC two
    // concurrent transactions can both snapshot "no open run" and both insert.)
    async withCronLock(fn) {
      const client = await pgPool.connect();
      try {
        const r = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [CRON_LOCK_KEY]);
        if (!r.rows[0].locked) return { acquired: false };
        try {
          return { acquired: true, result: await fn() };
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [CRON_LOCK_KEY]).catch(() => {});
        }
      } finally {
        client.release();
      }
    },
    async tryStartRun(trigger) {
      // Audit row only — the real mutual exclusion is withCronLock above.
      // Kept as a plain insert; concurrent inserts here are harmless history.
      const r = await q(`INSERT INTO scrape_runs (trigger) VALUES ($1) RETURNING *`, [trigger]);
      return r.rows[0] || null;
    },
    async finishRun(id, status) {
      await q('UPDATE scrape_runs SET completed_at=now(), status=$2 WHERE id=$1', [id, status]);
    },
    async listRuns(limit = 20) {
      const r = await q('SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT $1', [limit]);
      return r.rows;
    },
  };
}

function mapProduct(r) {
  return { id: r.id, storeProductId: r.store_product_id, name: r.name, productUrl: r.product_url, description: r.description, imageUrl: r.image_url, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapOption(r) {
  return { id: r.id, productId: r.product_id, optionName: r.option_name, optionValue: r.option_value, storeOptionId: r.store_option_id, createdAt: r.created_at, updatedAt: r.updated_at };
}
async function enrichPg(q, t) {
  const p = (await q('SELECT * FROM products WHERE id=$1', [t.product_id])).rows[0];
  const o = (await q('SELECT * FROM product_options WHERE id=$1', [t.option_id])).rows[0];
  return { id: t.id, productId: t.product_id, optionId: t.option_id, active: t.active, scrapeIntervalMinutes: t.scrape_interval_minutes, lastScrapedAt: t.last_scraped_at, lastSuccessAt: t.last_success_at, createdAt: t.created_at, updatedAt: t.updated_at, product: p ? mapProduct(p) : null, option: o ? mapOption(o) : null };
}

let db = null;
async function getDb() {
  if (db) return db;
  const { env } = require('./env');
  if (env.DATABASE_URL) {
    const { Pool } = require('pg');
    // Timeouts are critical for unattended runs: without connectionTimeoutMillis
    // a blackholed TCP connect hangs FOREVER (default 0 = no timeout),
    // freezing cron jobs with zero log output. Fail fast instead.
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
      statement_timeout: 120000,
    });
    db = createPgDb(pool);
  } else {
    db = createMemoryDb();
  }
  await db.init();
  return db;
}

module.exports = { getDb };
