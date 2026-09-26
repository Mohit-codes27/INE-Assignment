# INE Product Price Tracker

Reliable price/stock tracking for the INE mock store (`https://demo.inelabteamdev.com`) — **JavaScript** (Node + Express backend, React + Vite frontend, Supabase Postgres).

## Overview

Users search the mock store, pick a product + option (storage/kit/pack), track it, and get price/stock scraped every 2 hours via `cron-job.org`. Dashboard shows price charts, per-product scrape logs (every attempt, honest failures included), and CSV export.

**Priority order:** reliability → correctness → honest logging → scheduling → deployment → UI → bonuses.

## Features

- Partial/full-name product search (paged listings API + in-memory filter)
- Option/variant selection (exact-match — never "first price on page")
- HTTP-first metadata acquisition + manifest lookup, with Playwright performing
  the browser-gated price/stock extraction (the quote endpoint requires a live
  browser session, so HTTP price extraction is not attempted — see
  `docs/design-note.md`)
- Manifest-driven selectors via `buildSelectors()` (rotating classes from the
  live manifest; stable app hooks + button-text matching for the rest)
- 3 attempts with exponential backoff + error classification
- `scrape_attempts` (every attempt) vs `price_history` (validated successes only)
- Atomic scrape persistence (single transaction: attempts + history + touch + events + fingerprint)
- Protected `POST /api/cron/scrape` for cron-job.org, overlap-guarded by a
  held Postgres advisory lock (fails closed without `CRON_SECRET` in prod)
- CSV export of all attempts (failures with blank price/stock, ISO-8601 UTC)
- Headed mode: `npm run scrape:headed -- --tracked=<id>`
- Bonus: PRICE_DROP / BACK_IN_STOCK / STRUCTURE_CHANGED events, per-product frequency (`scrape_interval_minutes`), CI

## Architecture

```
Vercel (React) → Render (Express) → Supabase (Postgres)
                        ↕ Playwright + axios
                 demo.inelabteamdev.com
cron-job.org ──POST /api/cron/scrape──▶ every 2h
```

See `docs/architecture.md` and `docs/design-note.md`.

## Tech Stack

- Frontend: React 18, Vite, React Router, Axios, Recharts (plain JS, no TS)
- Backend: Node.js, Express, Axios, Cheerio, Playwright, `pg`, Zod, Pino, csv-stringify
- DB: Supabase Postgres (raw SQL in `supabase/schema.sql`; auto-created on boot)
- Scheduler: cron-job.org

## Project Structure

```
ine-product-price-tracker/
  client/  # React + Vite (JS)
  server/  # Express API + scraper service (JS)
  supabase/schema.sql
  docs/
```

## Local Setup

Prereqs: Node 18+.

```bash
cd ine-product-price-tracker
cp .env.example .env            # fill DATABASE_URL (or leave empty for in-memory dev store) + CRON_SECRET
npm --prefix server install
npm --prefix client install
```

Without `DATABASE_URL` the server runs on an in-memory store (dev only — history resets on restart). For real history set `DATABASE_URL` to Supabase (or local Postgres) and tables auto-create on boot (or apply `supabase/schema.sql`).

## Running Locally

```bash
npm run dev          # both client :5173 + server :5000 (from repo root, needs concurrently)
# or separately:
npm --prefix server run dev
npm --prefix client run dev
```

Flow: open `http://localhost:5173` → Search → Select product → choose option → Start Tracking → Scrape Now → View History.

## Running Headed Scraper

```bash
npm --prefix server install
npx playwright install chromium
npm run scrape:headed -- --tracked=<trackedProductId>
```

Opens a visible browser: consent dialog → option chip → hover dwell → "Check today's price" → retries → validation → DB update. Screen-record this for the demo.

## API Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ status: "ok" }` |
| GET | `/api/products/search?q=` | partial/full name |
| GET | `/api/products/:productId` | product + options |
| POST | `/api/tracked-products` | `{ productId, optionId }` (Zod) |
| GET | `/api/tracked-products` | list with product/option |
| GET | `/api/tracked-products/:id` | one |
| PATCH | `/api/tracked-products/:id` | `{ active: boolean }` (strict Zod boolean) |
| GET | `/api/tracked-products/:id/history?limit=` | successful history |
| GET | `/api/tracked-products/:id/logs?limit=` | every attempt, newest first |
| POST | `/api/tracked-products/:id/scrape` | manual scrape (same service) |
| POST | `/api/cron/scrape` | `Bearer CRON_SECRET`, overlap-guarded |
| GET | `/api/export/scrape-history.csv` | all attempts, ISO-8601 UTC |

Errors: `{ success: false, error: { code, message } }` (no stack traces in prod).

## CSV Export

`product_id,product_name,selected_option,timestamp,price,stock,outcome` — failures included with blank price/stock.

## Deployment

### Supabase
1. New project → copy connection string → set `DATABASE_URL`.
2. Run `supabase/schema.sql` in SQL editor (or let server auto-create on first boot).

### Render (backend) — Docker runtime (recommended)
- The repo ships `server/Dockerfile` based on Playwright's official image
  (Node + Chromium + OS deps). Render's native Node runtime cannot apt-get
  browser libraries, so without Docker every scrape fails fast with
  `BROWSER_NOT_INSTALLED`.
- Render dashboard → service → Settings → **Runtime: Docker**, Root Directory
  `server`. No build/start commands needed (Dockerfile's `npm install` + CMD).
- Env: `DATABASE_URL, STORE_BASE_URL, CRON_SECRET, FRONTEND_URL` (+ optional
  timeouts/concurrency). **Redeploy after switching runtime**, then Scrape Now
  should succeed instead of `BROWSER_NOT_INSTALLED`.
- Allocate at least 1 GB RAM if the plan allows; Chromium is the heaviest part.

### Vercel (frontend)
- Root: `client/`, build `npm run build`, output `dist`.
- Env: `VITE_API_BASE_URL=https://<render-backend>/api`.

### cron-job.org
`POST https://<render-backend>/api/cron/scrape`, header `Authorization: Bearer <CRON_SECRET>`, every 2 hours.

## Testing

```bash
npm --prefix server test   # node:test — parser/stock/options/retry/CSV unit tests
                           # + service tests: tracking validation, duplicates,
                           # failed scrape (3 attempts/0 history), success,
                           # retry-then-success, STRUCTURE_CHANGED, PRICE_DROP
```

Unit tests use stubbed scraper I/O (no live pages, no browser needed — CI does
not install Playwright browsers). The live store is verified manually via the
headed scrape.

## Reliability Decisions

- SPA store ⇒ HTTP-first metadata + manifest, Playwright unlocks price (proven by HTML probe, not assumed).
- Manifest-driven selectors via `buildSelectors()` + STRUCTURE_CHANGED events (fingerprint persisted per product, compared every scrape).
- Never `price || 0`; unknown stock stays unknown; history only on validated success.
- Atomic persistence (one transaction per finished scrape, pg) — no partial state.
- Concurrency 2, per-product due-check, advisory-lock cron overlap guard.

## Bonus Features

PRICE_DROP / BACK_IN_STOCK events, structure fingerprinting, configurable `scrape_interval_minutes`, GitHub Actions CI.

## AI Usage Disclosure

Scaffolded and written with AI assistance (OpenCode / Muse Spark), store behavior reverse-engineered from the live JS bundle and probing `/api/v2/*` endpoints, then manually verified. Review `docs/design-note.md` before the interview and re-run the headed scrape yourself so you can explain every step.
