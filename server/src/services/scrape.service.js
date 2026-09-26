'use strict';

// Scrape service: runs scrapeTrackedProduct, then persists the whole outcome
// ATOMICALLY via db.saveScrapeOutcome (attempts + optional history + tracking
// touch + events commit together or roll back together — never partial state).
// ONLY validated successes produce price_history rows.
// Bonus events: PRICE_DROP, BACK_IN_STOCK, STRUCTURE_CHANGED.

const { scrapeTrackedProduct } = require('../scraper/index');
const { pool } = require('../utils/concurrency');
const { env } = require('../config/env');

async function runSingle(trackedId, db, { headed = false, io = {}, onProgress = null } = {}) {
  const tracked = await db.getTracked(trackedId);
  if (!tracked) throw Object.assign(new Error('Tracked product not found.'), { status: 404, code: 'TRACKED_NOT_FOUND' });

  const prevLatest = await db.latestHistory(trackedId).catch(() => null);
  const prevFp = await db.getStructureFingerprint(trackedId).catch(() => null);
  const result = await scrapeTrackedProduct(tracked, { headed, db, io, onProgress });

  const events = [];
  if (result.ok) {
    events.push(...buildBonusEvents(prevLatest, result.data));
    // STRUCTURE_CHANGED: manifest fingerprint differs from the last stored
    // one. Logged as an event — validation (not the fingerprint) decides
    // whether extraction still works, so this never fails a scrape.
    // The new fingerprint is persisted INSIDE saveScrapeOutcome's transaction,
    // never before it: otherwise a tx failure could advance the fingerprint
    // while losing the scrape's history, silently swallowing the event.
    if (result.manifestFp && prevFp && prevFp !== result.manifestFp) {
      events.push({
        eventType: 'STRUCTURE_CHANGED',
        message: `Store layout fingerprint changed (${prevFp} -> ${result.manifestFp}). Extraction still validated.`,
        metadata: { previous: prevFp, current: result.manifestFp },
      });
    }
    await db.saveScrapeOutcome({
      trackedId,
      attempts: result.attempts,
      history: { trackedProductId: trackedId, price: result.data.price, stock: result.data.stock, scrapedAt: new Date().toISOString() },
      success: true,
      events,
      fingerprint: result.manifestFp || null,
    });
    return { success: true, data: result.data, attempts: result.attempts.length };
  }
  await db.saveScrapeOutcome({ trackedId, attempts: result.attempts, history: null, success: false, events: [] });
  return { success: false, errorCode: result.errorCode, errorMessage: result.errorMessage, attempts: result.attempts.length };
}

async function runAll(db, { trigger = 'manual', onlyDue = true } = {}) {
  const all = await db.listTracked();
  const due = all.filter((t) => t.active && (!onlyDue || isDue(t)));
  const results = await pool(due, env.SCRAPE_CONCURRENCY, (t) =>
    runSingle(t.id, db).then((r) => ({ id: t.id, ...r })).catch((e) => ({ id: t.id, success: false, errorMessage: e.message })));
  const vals = results.map((r) => r.value || r);
  const successful = vals.filter((v) => v.success).length;
  return { processed: vals.length, successful, failed: vals.length - successful, results: vals };
}

function isDue(t) {
  if (!t.lastScrapedAt) return true;
  const mins = (Date.now() - new Date(t.lastScrapedAt).getTime()) / 60000;
  return mins >= (t.scrapeIntervalMinutes || 120) - 1;
}

// Pure helper: bonus events derived from previous vs current validated data.
function buildBonusEvents(prevLatest, data) {
  const events = [];
  if (!prevLatest) return events;
  if (Number(data.price) < Number(prevLatest.price)) {
    events.push({
      eventType: 'PRICE_DROP',
      message: `Price dropped from ${prevLatest.price} to ${data.price}.`,
      metadata: { from: Number(prevLatest.price), to: Number(data.price) },
    });
  }
  const prevStock = prevLatest.stock === true || prevLatest.stock === 'true' || prevLatest.stock === 1;
  if (!prevStock && data.stock === true) {
    events.push({
      eventType: 'BACK_IN_STOCK',
      message: `${data.productName} (${data.optionValue}) is back in stock.`,
      metadata: {},
    });
  }
  return events;
}

module.exports = { runSingle, runAll, buildBonusEvents };
