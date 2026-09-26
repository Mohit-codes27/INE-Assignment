'use strict';

// scrapeTrackedProduct(tracked, { headed, io })
// Pipeline: HTTP-first metadata acquisition + manifest lookup, then Playwright
// for the browser-gated price/stock extraction, then validation.
// Every attempt is returned so the caller (scrape.service) can persist them
// honestly; ONLY validated successes produce price_history rows.
// `io` allows tests to inject stubs { fetchItemFn, fetchManifestFn, scrapeFn }
// without touching the real retry/validation logic under test.

const { env } = require('../config/env');
const { fetchItem, fetchManifest, probeProductPageHtml } = require('./http-scraper');
const { scrapeWithPlaywright } = require('./playwright-scraper');
const { validateScraped } = require('./parser');
const { isRetryable, backoffMs } = require('./retry');
const { fingerprintManifest } = require('./structure-fingerprint');
const { sleep } = require('../utils/concurrency');
const logger = require('../utils/logger');

function logLine(fields) {
  logger.info('[SCRAPE] ' + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' '));
}

async function scrapeTrackedProduct(tracked, { headed = false, db = null, io = {}, onProgress = null } = {}) {
  const { fetchItemFn = fetchItem, fetchManifestFn = fetchManifest, scrapeFn = scrapeWithPlaywright } = io;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const maxAttempts = env.MAX_SCRAPE_ATTEMPTS;
  const attempts = []; // returned so service can persist every attempt honestly
  const storeProductId = tracked.product.storeProductId;
  const optionLabel = tracked.option.optionValue;
  const sourceUrl = `${env.STORE_BASE_URL}/item/${encodeURIComponent(storeProductId)}`;

  // Pre-flight over HTTP: confirm product + option still exist (cheap, no browser).
  const meta = await fetchItemFn(storeProductId);
  if (!meta.ok && !isRetryable(meta.code)) {
    const a = toAttempt(tracked, 1, 'http', meta, null);
    attempts.push(a);
    return { ok: false, attempts, errorCode: meta.code, errorMessage: meta.message };
  }
  let item = meta.ok ? meta.item : null;
  if (meta.ok) {
    const labels = (item.options || []).map((o) => o.label);
    if (labels.length && !labels.some((l) => String(l).toLowerCase() === String(optionLabel).toLowerCase())) {
      const a = { trackedProductId: tracked.id, attemptNumber: 1, status: 'failed', strategy: 'http', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: meta.durationMs, price: null, stock: null, httpStatus: 200, errorCode: 'OPTION_NOT_FOUND', errorMessage: `Option "${optionLabel}" not on product page.` };
      attempts.push(a);
      return { ok: false, attempts, errorCode: 'OPTION_NOT_FOUND', errorMessage: a.errorMessage };
    }
  }

  // Manifest fetch feeds structure-change detection (bonus, non-blocking)
  // and gives the browser extractor the current price-node class (rotates).
  let manifestFp = null;
  let manifest = null;
  try {
    const mf = await fetchManifestFn();
    if (mf.ok) { manifest = mf.manifest; manifestFp = fingerprintManifest(mf.manifest); }
  } catch { /* ignore */ }

  // HTML probe documents the SPA reality (debug aid, never blocks).
  probeProductPageHtml(storeProductId).then((p) => {
    if (p.ok) logLine({ product: storeProductId, probe: `root=${p.hasRoot} priceInHtml=${p.hasPriceInHtml}` });
  }).catch(() => {});

  let lastError = { code: 'UNKNOWN', message: 'Scrape failed.' };
  const totalAttempts = maxAttempts;
  for (let n = 1; n <= totalAttempts; n++) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    logLine({ product: storeProductId, option: optionLabel, attempt: n, strategy: 'playwright', status: 'started' });
    progress({ type: 'attempt-start', attempt: n, totalAttempts, strategy: 'playwright' });
    try {
      const r = await scrapeFn({ storeProductId, optionLabel, sourceUrl, headed, manifest, onProgress: progress });
      const v = validateScraped(r.data);
      if (!v.ok) throw Object.assign(new Error(v.message), { code: v.code });
      const attempt = { trackedProductId: tracked.id, attemptNumber: n, status: 'success', strategy: 'playwright', startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - t0, price: r.data.price, stock: r.data.stock, httpStatus: null, errorCode: null, errorMessage: null };
      attempts.push(attempt);
      logLine({ product: storeProductId, option: optionLabel, attempt: n, strategy: 'playwright', status: 'success', price: r.data.price, stock: r.data.stock, duration: `${attempt.durationMs}ms` });
      progress({ type: 'attempt-success', attempt: n, price: r.data.price, stock: r.data.stock });
      return { ok: true, attempts, data: r.data, manifestFp };
    } catch (err) {
      const { code, message } = classifyBrowserError(err);
      lastError = { code, message };
      const done = n >= totalAttempts || !isRetryable(code);
      const attempt = { trackedProductId: tracked.id, attemptNumber: n, status: done ? 'failed' : 'retried', strategy: 'playwright', startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - t0, price: null, stock: null, httpStatus: null, errorCode: code, errorMessage: message };
      attempts.push(attempt);
      logLine({ product: storeProductId, option: optionLabel, attempt: n, strategy: 'playwright', status: attempt.status, error: code, duration: `${attempt.durationMs}ms` });
      if (!done) {
        const waitMs = backoffMs(n);
        progress({ type: 'attempt-retry', attempt: n, code, message, waitMs });
        await sleep(waitMs);
      } else {
        progress({ type: 'attempt-failed', attempt: n, code, message });
        break;
      }
    }
  }
  return { ok: false, attempts, errorCode: lastError.code, errorMessage: lastError.message, manifestFp };
}

// Turn opaque launch errors into actionable, fail-fast codes instead of a
// generic BROWSER_ERROR retried 3 times to no effect.
function classifyBrowserError(err) {
  const raw = err.message || 'Playwright scrape failed';
  if (err.code === 'MODULE_NOT_FOUND' || /cannot find module ['"]playwright['"]/i.test(raw)) {
    return { code: 'PLAYWRIGHT_NOT_INSTALLED', message: 'Playwright npm package is missing. Run: npm --prefix server install' };
  }
  if (/executable doesn't exist|has not been downloaded|browser.*not found/i.test(raw)) {
    return {
      code: 'BROWSER_NOT_INSTALLED',
      message: 'Playwright Chromium binary is missing. Run: npx playwright install chromium (inside server/). Then retry the scrape.',
    };
  }
  return { code: err.code || 'BROWSER_ERROR', message: raw.slice(0, 500) };
}

function toAttempt(tracked, n, strategy, meta) {
  const now = new Date().toISOString();
  return { trackedProductId: tracked.id, attemptNumber: n, status: 'failed', strategy, startedAt: now, completedAt: now, durationMs: meta.durationMs || 0, price: null, stock: null, httpStatus: meta.httpStatus ?? null, errorCode: meta.code, errorMessage: meta.message };
}

module.exports = { scrapeTrackedProduct };
