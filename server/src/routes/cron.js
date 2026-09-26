'use strict';

const express = require('express');
const { getDb } = require('../config/database');
const { ok, cronAuth } = require('../middleware/http');
const scrapeService = require('../services/scrape.service');
const logger = require('../utils/logger');

const router = express.Router();

// POST /api/cron/scrape — called by cron-job.org every 2 hours.
// Protected by Authorization: Bearer <CRON_SECRET>. Overlap-guarded by a
// Postgres advisory lock held for the whole run (see db.withCronLock);
// scrape_runs rows are audit history, not the lock itself.
//
// IMPORTANT: free schedulers (cron-job.org) allow only ~30s per request, but
// a real run needs minutes (cold start + browser scrapes). So this endpoint
// acknowledges IMMEDIATELY and scrapes in the background with the lock still
// held. Outcomes land in scrape_runs (see GET /api/cron/runs) + server logs,
// never in the HTTP response — there is no summary in the 200 body by design.
router.post('/cron/scrape', cronAuth, async (req, res, next) => {
  const t0 = Date.now();
  try {
    const db = await getDb();
    const gate = await db.withCronLock(async () => {
      const run = await db.tryStartRun('cron');
      ok(res, {
        acknowledged: true,
        runId: run ? run.id : null,
        status: 'running',
        note: 'Scrape continues in background; outcome in scrape_runs + server logs.',
      });
      try {
        const summary = await scrapeService.runAll(db, { trigger: 'cron', onlyDue: true });
        if (run) await db.finishRun(run.id, 'completed').catch(() => {});
        logger.info(`[CRON] background run ${run ? run.id : '?'} finished processed=${summary.processed} successful=${summary.successful} failed=${summary.failed} durationMs=${Date.now() - t0}`);
      } catch (e) {
        if (run) await db.finishRun(run.id, 'failed').catch(() => {});
        logger.error(`[CRON] background run failed: ${e.message}`);
      }
      return { background: true, runId: run ? run.id : null };
    });
    if (!gate.acquired) {
      return ok(res, { processed: 0, successful: 0, failed: 0, skipped: 'previous run still active', durationMs: Date.now() - t0 });
    }
    // Background path already responded above; this only runs for exotic
    // flows where fn returned without responding.
    if (!res.headersSent) ok(res, gate.result);
  } catch (e) { next(e); }
});

// GET /api/cron/runs — recent scheduled-run audit trail (same cron secret).
// This is how you verify background runs completed: status + timestamps.
router.get('/cron/runs', cronAuth, async (req, res, next) => {
  try {
    const db = await getDb();
    ok(res, await db.listRuns(Math.min(Number(req.query.limit) || 20, 100)));
  } catch (e) { next(e); }
});

module.exports = router;
