# Abersons Flow Report

Abersons Flow Report is the Lightspeed Retail replacement for the old RMH /
datatailor flow report. It combines live Lightspeed products, purchase orders,
vendor returns, sales, and inventory with the imported old-report PO history that
never made it into Lightspeed.

For domain rules and AI-maintenance guidance, start with `CLAUDE.md`. That file
is the source of truth for scan behavior, SKU/season rules, rollup formulas,
testing policy, and "what not to do" notes.

## Stack

- Next.js pages router
- React 18
- Vercel KV / Upstash Redis for scan state, caches, and imported old-report data
- Iron Session for report auth
- Lightspeed Retail API v2
- Jest for unit tests
- ESLint 9 flat config + Prettier

## Local Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create `.env.local` from `.env.example` and fill in the real values.

3. Run the app:

   ```sh
   npm run dev
   ```

4. Open `http://localhost:3000`.

The app expects authenticated staff sessions. Most scan and cache routes also
accept `Authorization: Bearer $CRON_SECRET` for GitHub Actions / Vercel cron.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the local Next.js dev server. |
| `npm run build` | Build the production app. |
| `npm start` | Start a built production app. |
| `npm run lint` | Run ESLint over the repo. |
| `npm run format` | Run Prettier over non-ignored files. Markdown is intentionally ignored. |
| `npm run format:check` | Check Prettier formatting. |
| `npm test` | Run Jest. |
| `npm run test:ci` | Run Jest in CI mode. |

## Data Sources

- **Lightspeed Retail**: live products, on-hand inventory, LS purchase orders,
  vendor returns, and sales.
- **Datatailor hard pull**: old RMH-era ordered/received/product detail imported
  through `pages/api/import/datatail.js` and stored in KV under
  `scan:override:{season}:*`.
- **Request-time rollup**: `lib/flow-rollup.js` builds canonical product rows and
  rolls them up bottom-up so the summary, vendor list, and drilldown header agree.

## Sync Model

Scheduled GitHub Actions keep the data current, and the browser polls for
updates on top of them:

- **Nightly incremental scan**: `.github/workflows/nightly-scan.yml` calls
  `/api/cron/scan` to advance products, POs, vendor returns, sales, and inventory.
- **Weekly full rebuild**: `.github/workflows/weekly-full-scan.yml` calls
  `/api/cron/scan` with `restart=1` (and optional cache resets) for a cold rebuild.
- **Delta sync**: `.github/workflows/delta-scan.yml` calls `/api/cron/delta` for
  sales-only updates during store hours.
- **Validation**: `.github/workflows/nightly-validate.yml` calls
  `/api/scan/validate` to check cache/report consistency and persist drift
  history for Data Health.

The browser also polls for updated scan data and refreshes the current view when
newer scan or delta results are available.

## Documentation Map

- `CLAUDE.md`: authoritative AI and domain context. Read this before changing
  scan math, rollups, seasons, sales classification, or validation.
- `docs/flows.md`: diagrams for old-to-new lineage, scan phases, sync paths,
  rollup merging, and sale classification.
- `lib/__tests__/`: executable specs for pure business logic.
- `pages/api/scan/step.js`: chunked full-scan pipeline.
- `pages/api/cron/scan.js`: full-scan orchestration.
- `pages/api/cron/delta.js`: sales-only delta orchestration.
- `pages/api/scan/validate.js`: Lightspeed/cache validation harness.
- `pages/api/scan/reconcile.js`: old-report-vs-new-rollup reconciliation.

## Accuracy Notes

The old report's comparable ground truth is imported into KV by
`pages/api/import/datatail.js`. The reconciliation endpoint compares that
imported old-report data with the current request-time rollup. Those override
records currently have a 30-day TTL, so reconciliation requires a recently
imported season unless a future permanent baseline is added.

On hand is always sourced from live Lightspeed inventory. Manual Lightspeed
inventory corrections can make on-hand differ from derived PO/sales math; this is
expected and surfaced in Data Health.

## AI Maintenance Rules

- Keep `CLAUDE.md` current when domain behavior changes.
- Keep tests with behavior changes; prefer pure helpers under `lib/`.
- Run `npm test`, `npm run lint`, and `npm run build` before pushing code changes.
- Use Conventional Commits for commits; see `CLAUDE.md`.
- Codacy is not used as a required gate for this project.
