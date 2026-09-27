'use strict';

// Standalone scheduled scrape runner for GitHub Actions (or any machine with
// a browser). SAME production code path as POST /api/cron/scrape: due-product
// check, concurrency pool, attempts/history/events persistence, advisory
// overlap lock — only the trigger differs (scheduler clock vs HTTP call).
// Needs DATABASE_URL (+ optional STORE_BASE_URL) in the environment.

const { getDb } = require('./config/database');
const scrapeService = require('./services/scrape.service');
const logger = require('./utils/logger');

async function main() {
  const db = await getDb();
  const gate = await db.withCronLock(async () => {
    const run = await db.tryStartRun('github-actions');
    try {
      const summary = await scrapeService.runAll(db, { trigger: 'github-actions', onlyDue: true });
      if (run) await db.finishRun(run.id, 'completed').catch(() => {});
      return summary;
    } catch (e) {
      if (run) await db.finishRun(run.id, 'failed').catch(() => {});
      throw e;
    }
  });
  if (!gate.acquired) {
    logger.info('[CRON] skipped: previous run still active');
  } else {
    const s = gate.result;
    logger.info(`[CRON] finished processed=${s.processed} successful=${s.successful} failed=${s.failed}`);
  }
  await db.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
