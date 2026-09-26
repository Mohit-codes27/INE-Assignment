'use strict';

// Playwright extraction for the browser-gated price/stock quote.
// Flow mirrors what a real user does:
//   1. open /item/:id, dismiss random consent dialog (up to 3 clicks)
//   2. click the tracked option chip (exact label match — never first price)
//   3. hover the locked price panel (>=8 moves, real mouse) to satisfy dwell check
//   4. click "Check today's price", wait for the unlocked panel
//   5. extract ONLY the visible price node (ignore display:none decoys),
//      parse with parser.js, validate, return.
// All selectors come from buildSelectors(manifest): rotating classes from the
// live manifest, stable app hooks from STABLE_SELECTORS, text matching for the
// unlock button. Browser is always closed in `finally` — no orphaned processes.

const { env } = require('../config/env');
const { parsePrice, parseStock, matchOption } = require('./parser');
const { buildSelectors } = require('./selectors');

let playwright = null;
function pw() {
  if (!playwright) playwright = require('playwright');
  return playwright;
}

async function dismissConsent(page, sel) {
  for (let i = 0; i < 4; i++) {
    const box = page.locator(sel.consentBox);
    if ((await box.count()) === 0) return;
    const btn = box.locator('button').first();
    if ((await btn.count()) === 0) return;
    await btn.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  throw Object.assign(new Error('Consent dialog could not be dismissed.'), { code: 'CONSENT_BLOCKED' });
}

async function scrapeWithPlaywright({ storeProductId, optionLabel, sourceUrl, headed, timeoutMs, manifest, onProgress = null }) {
  const started = Date.now();
  const strategy = 'playwright';
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const sel = buildSelectors(manifest);
  const browser = await pw().chromium.launch({ headless: headed === true ? false : env.HEADLESS });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.setDefaultTimeout(timeoutMs || env.BROWSER_TIMEOUT_MS);
    progress({ type: 'navigating', sourceUrl });
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: env.BROWSER_TIMEOUT_MS });
    } catch (e) {
      throw Object.assign(new Error(`Navigation timeout for ${sourceUrl}`), { code: 'NAV_TIMEOUT' });
    }

    await dismissConsent(page, sel).catch((e) => { throw e; });
    await page.waitForSelector(sel.productReady, { timeout: 15000 }).catch(() => {
      throw Object.assign(new Error('Product page never rendered (store flake).'), { code: 'STORE_FLAKY_DROP' });
    });
    progress({ type: 'page-ready' });

    // 1. product identity from the rendered page
    const productName = (await page.locator(sel.summaryTitle).first().textContent().catch(() => '')).trim();
    if (!productName) throw Object.assign(new Error('Product name not rendered.'), { code: 'PRICE_NOT_FOUND' });

    // 2. select the EXACT tracked option (never the default highlighted chip)
    const chips = page.locator(sel.optionChip);
    const n = await chips.count();
    if (n > 1) {
      let clicked = null;
      for (let i = 0; i < n; i++) {
        const label = ((await chips.nth(i).textContent()) || '').trim();
        if (matchOption(optionLabel, label)) {
          await chips.nth(i).click({ timeout: 5000 });
          clicked = label;
          break;
        }
      }
      if (!clicked) throw Object.assign(new Error(`Option "${optionLabel}" not found on page.`), { code: 'OPTION_NOT_FOUND' });
      progress({ type: 'option-selected', label: clicked });
      await page.waitForTimeout(400);
    } else {
      progress({ type: 'option-skipped' });
    }

    // 3. hover the locked panel with a real mouse (>=8 moves over the panel)
    const panel = page.locator(sel.panel);
    const box = await panel.first().boundingBox().catch(() => null);
    if (box) {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      for (let i = 0; i < 12; i++) {
        await page.mouse.move(cx + (i % 5) * 12, cy + (i % 3) * 8);
        await page.waitForTimeout(80);
      }
    }
    await page.waitForTimeout(700); // dwell >= 600ms

    // 4. click unlock (selector first, button-text fallback); the page itself
    //    retries the quote request up to 6 times internally
    const checkBtn = page.locator(`${sel.unlockButton}, ${sel.panel} button:has-text("${sel.unlockButtonText}")`).first();
    progress({ type: 'unlocking' });
    await checkBtn.click({ timeout: 8000 }).catch(() => {
      throw Object.assign(new Error('Price unlock button never became clickable.'), { code: 'EXTRACT_TIMEOUT' });
    });

    await page.waitForSelector(sel.ready, { timeout: env.BROWSER_TIMEOUT_MS }).catch(async () => {
      const failed = await page.locator(sel.failed).count();
      const msg = failed ? (await page.locator(sel.failed).first().textContent()) : 'price panel never unlocked';
      const err = new Error(String(msg).slice(0, 300));
      err.code = 'CHALLENGE_FAILED';
      throw err;
    });
    progress({ type: 'unlocked' });

    // 5. extract the VISIBLE price. The store rotates layout: with priceCarrier
    //    "split" the price node holds one <span> per CHARACTER, so single-node
    //    heuristics return one digit. Fix: prefer the manifest's priceValue
    //    node (full text in both modes); fall back to the visible node with
    //    the LONGEST digit run. display:none decoys, line-through MRP and
    //    "Member price" text are excluded.
    const priceText = await page.evaluate((s) => {
      const row = document.querySelector(s.row);
      if (!row) return '';
      const shown = (el) => {
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        if (el.style.display === 'none') return false;
        return true;
      };
      if (s.priceValue) {
        const el = row.querySelector(s.priceValue);
        if (el && shown(el)) {
          const t = (el.textContent || '').trim();
          if (/\d/.test(t)) return t;
        }
      }
      let best = '', bestDigits = 0;
      for (const el of row.querySelectorAll('*')) {
        if (!shown(el)) continue;
        const st = window.getComputedStyle(el);
        if (st.textDecorationLine === 'line-through') continue; // MRP
        const t = (el.textContent || '').trim();
        if (!/[₹\d]/.test(t) || t.length > 80) continue;
        if (/member price|saving/i.test(t)) continue;
        if (/sale|mrp|save|saving/i.test(el.className || '')) continue;
        const digits = (t.match(/\d/g) || []).length;
        if (digits < 2) continue; // ignore split single chars / stray digits
        if (digits > bestDigits) { bestDigits = digits; best = t; }
      }
      return best;
    }, { row: sel.row, priceValue: sel.priceValue });

    const stockText = await page.evaluate((s) => {
      const el = document.querySelector(`${s.facts}, ${s.ready}`);
      return el ? el.textContent || '' : '';
    }, { facts: sel.facts, ready: sel.ready });

    const price = parsePrice(priceText);
    if (!price.ok) {
      const e = new Error(`Price parse failed (${price.reason}): "${String(priceText).slice(0, 80)}"`);
      e.code = price.reason || 'PRICE_NOT_FOUND';
      throw e;
    }
    const stock = parseStock(stockText);
    if (!stock.ok) {
      const e = new Error(`Stock parse failed (${stock.reason})`);
      e.code = stock.reason || 'STOCK_UNKNOWN';
      throw e;
    }
    progress({ type: 'extracted', price: price.value, stock: stock.value });

    return {
      success: true,
      data: {
        storeProductId: String(storeProductId),
        productName,
        optionName: 'option',
        optionValue: optionLabel,
        price: price.value,
        stock: stock.value,
        sourceUrl,
      },
      strategy,
      durationMs: Date.now() - started,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeWithPlaywright };
