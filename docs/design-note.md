# Design Note — INE Product Price Tracker

## 1. How the scraping was made reliable

**Store reconnaissance came before selectors.** The mock store is a React SPA:
`GET /` returns an empty `<div id="root">`, so no price ever exists in HTML
(proven by an HTML probe, not assumed). Its JSON APIs give catalog
(`/api/v2/listings`), item details with options (`/api/v2/items/:id`) and a
layout manifest (`/api/v2/ui/manifest`) — but price/stock are gated behind
hover-dwell tracking, consent dialogs, ~35% navigation flakiness, and a
fingerprint + WASM-challenge quote flow that only a live browser can complete.

**So the architecture is: HTTP-first metadata acquisition, Playwright for
browser-gated extraction.** Axios fetches product/option existence and the
manifest (cheap); a real Chromium session does consent dismissal, exact option
selection, hover dwell, price unlock, and visible-price extraction. We deliberately
do *not* attempt HTTP price extraction first — it would fail by design.

**Correctness guards at every layer:**
- `buildSelectors(manifest)` — rotating classes come from the live manifest;
  stable app hooks and button-text matching cover the rest. Nothing rotating
  is hardcoded.
- Exact option matching — the clicked chip's label must equal the tracked
  option; never "first price on the page".
- Strict parsing — no `price || 0`, no `stock || false`. Unknown stays unknown;
  invisible split-span separators are defeated by keeping only digits/`.,`.
- Validation before persistence — only validated successes create
  `price_history`; every attempt (success/retried/failed, nullable price/stock)
  is logged to `scrape_attempts`.
- Retry (max 3, exponential backoff + jitter) with error classification —
  timeouts/5xx/parse-misses retry; bad config/404/option-mismatch fail fast.
- Atomic persistence — attempts + history + touch + events + fingerprint commit
  in one transaction, never partial.
- Scheduling — external clock (GitHub Actions every 2h), advisory-lock overlap
  guard, per-product due-checks. No `setInterval` (dies on sleep).
- Change detection — manifest fingerprints persisted per product; a change
  emits `STRUCTURE_CHANGED` without failing the scrape.

## 2. Trade-offs

- **Fresh browser per scrape (~1–2 min/product) vs persistent browser.**
  Chose slow + leak-proof (`finally` close) over fast + orphaned-process risk.
- **Concurrency 2** — polite to the mock store and bounded on RAM, instead of
  fast unbounded parallelism.
- **GitHub Actions over cron-job.org / in-process timers.** cron-job.org's 30s
  capture budget and opaque fetch errors made sync summaries unworkable, so the
  endpoint acks immediately and scrapes in the background (audit via
  `scrape_runs`). In-process timers die with sleeping hosts.
- **Raw SQL over an ORM.** Small model, explicit queries and schema — defensible
  and interview-explainable.

## 3. What the AI tools got wrong on the first attempt, and how it was corrected

1. **"Single-statement INSERT…WHERE NOT EXISTS is atomic."** Wrong: under MVCC
   two concurrent transactions can both snapshot "no open run" and both insert.
   Replaced with a properly held Postgres advisory lock (dedicated connection,
   unlock in `finally`), plus a test proving overlap is refused.
2. **README claimed STRUCTURE_CHANGED events that didn't exist.** The code
   fingerprinted the manifest but never compared, persisted, or emitted.
   Implemented properly (per-product stored fingerprint → compare → event) with
   a service test; the fingerprint write was then moved *inside* the persistence
   transaction after review caught it sitting outside.
3. **Price extractor returned one digit — twice.** First the "biggest font"
   heuristic picked the last character of split-span prices; then the parser's
   allow-listed invisible separators let an unknown joiner through, yielding
   the first digit. Fixed with manifest-driven node selection + keep-only-digits
   parsing, each confirmed by failing-then-passing tests.
4. **"HTTP scraper with Playwright fallback."** Inaccurate marketing of our own
   design — corrected everywhere to "HTTP-first metadata + Playwright for
   browser-gated extraction."
5. **Tests hit the real Supabase** once `DATABASE_URL` was set locally.
   Forced in-memory isolation (`DATABASE_URL=''`) at the top of service tests.
6. **pg pool had no connection timeout** — a blackholed connect hangs forever
   with zero logs, exactly what a 15-minute "stuck" Actions run turned out to
   be adjacent to. Added connection + statement timeouts and timestamped stage
   logging so the next stall names its own location.
7. **Cron returned the full summary synchronously** — unworkable under a 30s
   scheduler budget. Split into immediate ack + background run, with
   `GET /api/cron/runs` as the audit trail.
