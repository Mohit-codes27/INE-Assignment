'use strict';

// Headed demo CLI: npm run scrape:headed -- --tracked=<id>
// Uses the SAME production scrapeTrackedProduct with headless=false so the
// retry/fallback behavior can be observed and screen-recorded.
// Progress lines below are driven by REAL scraper milestones (onProgress) —
// nothing is printed for steps that didn't happen.

require('dotenv').config();
const { getDb } = require('./config/database');
const scrapeService = require('./services/scrape.service');

function formatINR(v) {
  return `₹${Number(v).toLocaleString('en-IN')}`;
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--tracked='));
  const trackedId = arg ? arg.split('=')[1] : process.env.TRACKED_ID;
  if (!trackedId) {
    console.error('Usage: npm run scrape:headed -- --tracked=<trackedProductId>');
    process.exit(1);
  }
  const db = await getDb();
  const tracked = await db.getTracked(trackedId);
  if (!tracked) {
    console.error(`❌ Tracked product ${trackedId} not found in this database.`);
    console.error('   If the server uses a different DB (e.g. in-memory vs Postgres),');
    console.error('   set the same DATABASE_URL here so both share state.');
    await db.close();
    process.exit(1);
  }

  console.log('🚀 Starting headed scrape...');
  console.log(`🔎 Product: ${tracked.product ? tracked.product.name : trackedId}`);
  console.log(`⚙️  Option: ${tracked.option ? tracked.option.optionValue : '(unknown)'}`);

  const onProgress = (e) => {
    switch (e.type) {
      case 'attempt-start':
        if (e.attempt > 1) console.log(`\n🔁 Attempt ${e.attempt}/${e.totalAttempts}...`);
        break;
      case 'navigating':
        console.log('🌐 Opening product page...');
        break;
      case 'page-ready':
        console.log('📄 Page loaded (consent handled).');
        break;
      case 'option-selected':
        console.log(`🖱️  Selecting option "${e.label}"...`);
        break;
      case 'unlocking':
        console.log('⏳ Waiting for price/stock (challenge running, store may retry)...');
        break;
      case 'unlocked':
        console.log('🔓 Price panel unlocked, extracting...');
        break;
      case 'attempt-retry':
        console.log(`⚠️  Attempt ${e.attempt} failed (${e.code}) — retrying in ${(e.waitMs / 1000).toFixed(1)}s...`);
        break;
      default:
        break;
    }
  };

  const result = await scrapeService.runSingle(trackedId, db, { headed: true, onProgress });
  if (result.success) {
    console.log(`✅ Price: ${formatINR(result.data.price)}`);
    console.log(`✅ Stock: ${result.data.stock ? 'In stock' : 'Sold out'}`);
    console.log(`📊 Scrape successful (${result.attempts} attempt${result.attempts > 1 ? 's' : ''}, persisted to DB)`);
  } else {
    console.log(`❌ Scrape failed (${result.errorCode}): ${result.errorMessage}`);
    console.log('   Attempts logged honestly; history untouched.');
  }
  console.log(JSON.stringify(result, null, 2));
  await db.close();
  process.exit(result.success ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
