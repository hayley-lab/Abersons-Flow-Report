# Abersons Flow Report — Project Context

## Git Workflow
All commits go to branch `claude/determined-brown-C3xNA`. **Always work on this branch directly** — never commit to local `main`. Use `git push origin claude/determined-brown-C3xNA`. Before first commit in a session, run `git config user.email noreply@anthropic.com && git config user.name Claude`.

### Conventional Commits (AI MUST follow)
Every commit message MUST use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<optional scope>): <short description>

[optional body — explain why, not what; wrap at ~72 chars]

[optional footer — e.g. Fixes #123]
```

**Rules:**
- **Subject line is mandatory** and MUST match `<type>(<scope>): <description>`.
- Use **imperative mood** in the subject (`fix scan totals`, not `fixed` / `fixes`).
- Keep the subject **≤ 72 characters**. No trailing period.
- **Scope** is optional but encouraged for multi-area repos (`scan`, `ui`, `lib`, `auth`, `cron`, `docs`).
- Use a **body** when the change needs context beyond the subject (bug root cause, trade-off, migration note).
- **One logical change per commit** — do not bundle unrelated fixes.

**Allowed types:**

| Type | When to use |
|------|-------------|
| `feat` | New user-facing behavior or capability |
| `fix` | Bug fix |
| `docs` | Documentation only (`CLAUDE.md`, README, comments that document behavior) |
| `test` | Adding or updating tests only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `style` | Formatting, whitespace, semicolons — no logic change |
| `build` | Build system or external dependencies |
| `ci` | CI/CD configuration |
| `chore` | Maintenance that doesn't fit above (deps bump, tooling) |

**Examples (good):**
```
fix(scan): record vendor returns using SUPPLIER_RETURN type
feat(ui): auto-refresh when delta sync completes
docs: add conventional commit guidelines to CLAUDE.md
test(lib): add regression tests for sale-vs-on-sale classification
refactor(scan): extract flow math into lib/flow-math.js
```

**Examples (bad — never use):**
```
Fixed bug
Update files
WIP
Merge stuff
f8a5ef5 Fix flow report accuracy with shared math...
```

**Before committing:** run `npm test` and `npm run lint` when the repo has those scripts and your change touches code (see Testing Policy when present).

## Background
Abersons switched POS systems from RMH (old) to Lightspeed Retail / LS (new). The old flow report was connected to RMH. This new app connects to LS and replaces it. Sales history was transferred into LS, but not all POs were — some older POs were hard-pulled from the old flow report.

## Tech Stack
- Next.js 14 pages router
- Vercel KV (Redis/Upstash) for scan state and cached results
- Iron-session for auth
- Lightspeed Retail API v2 (`https://{LS_DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0/`)

## How The Data Is Supposed To Work (Hayley's Spec)

### 1. Hard Pull (datatail import)
Old PO ordered/received data that never made it into LS was imported directly into the app (via `pages/api/import/datatail.js`). This covers ordered & received quantities and dollars from the RMH era. These amounts must ADD to any matching LS POs — they must not be double-counted or overwritten.
- **Pending:** Carrie had a vendor return entered in the wrong season — need to check Staud in spring26.

### 2. LS POs (consignments in LS API, type=SUPPLIER)
Pull ordered and received quantities and dollars from LS purchase orders. These go into the Ordered and Received columns. Must not collide with the hard pull data.
- Ordered/Received qty in designated columns (qty, not dollars)
- Retail $ summed into color key and pushed to header
- Cost $ also shown in header
- When a product is received, it adds to both the Received column AND the On Hand column
- Partial receipts work correctly — LS tracks ordered qty and received qty separately per PO line item, so if 2 are ordered and 1 comes in, ordered shows 2 and received shows 1

**On Hand (product level):** Pulled directly from LS live inventory count — NOT calculated from a formula. This is accurate because LS updates its inventory in real time when items are received, sold, returned, or sent back to vendor. Formula for reference: `received qty − vendor returns − sold − on sale + customer returns` — but LS handles this internally.

**Caveat:** If inventory is manually adjusted in LS (e.g. during a physical inventory count or a manual correction), the on-hand count in the flow report will reflect that adjustment. This means on-hand can diverge from what the received/sold/returned columns would mathematically imply. This is expected behavior — LS is the source of truth for inventory. Worth noting to staff: manual LS inventory adjustments will show up here.

**DEFERRED — On-hand reconciliation indicator:** When the LS on-hand qty doesn't reconcile with `received_qty − vendor_return_qty − sold − on_sale + customer_returns`, show a small indicator (e.g. `≠` icon with tooltip) next to the on-hand number so staff know a manual adjustment occurred. Requires storing received qty and vendor return qty per product in the scan (currently only stored as dollars). Build after the product-finding bug is fixed.


### 3. Vendor Returns (consignments in LS API, type=SUPPLIER_RETURN)
Vendor returns reduce received inventory and go into the Returned column.
- Qty goes into Returned column
- Retail $ summed into color key
- The Received and Returned columns show their actual totals (not netted against each other)
- The **header total for Received (retail)** = received retail dollars − returned retail dollars (netted)
- The **header total for Received (cost)** = received cost dollars − returned cost dollars (same netting rule as retail). **For consignment/datatail-only vendors, received cost = $0 (no upfront cost on consignment), so do not show a negative — cap at $0.**

### 4. Sales (LS sales API)
- **Full-price sale:** qty removed from stock, placed in Sold column, retail $ in color key
- **Discounted sale (any discount, including 100% off):** qty goes into On Sale column (NOT Sold), color key uses the ACTUAL sold dollar amount (e.g. 50% off → half price; 100% off → $0)
- **Customer return of full-price item:** qty removed from Sold column, added back to on-hand (LS handles on-hand automatically)
- **Customer return of discounted item:** qty removed from On Sale column, added back to on-hand (LS handles on-hand automatically)
- Sold and On Sale columns are mutually exclusive — an item is in one or the other, never both

### ⚠️ RETURNED Column — Vendor Returns ONLY
**The RETURNED column has absolutely nothing to do with customer returns.**
- RETURNED column = items physically sent back to the vendor (vendor returns, type=SUPPLIER_RETURN consignments in LS)
- Tracked in `ps.retQty` (quantity) and `ps.retVal` / `ps.retCost` (dollars)
- Customer returns ONLY affect the Sold or On Sale column (subtracting from whichever the item sold from) and On Hand (LS updates automatically). They do NOT touch the Returned column at all.
- `ps.returned` in productStats is kept only for potential future use (on-hand reconciliation indicator). It must NEVER be displayed in the Returned column or used in any Returned column calculation.

## Sync Schedule
Three separate mechanisms keep data current:

1. **Nightly full scan** — rescans EVERYTHING (products, POs, vendor returns, sales). Runs in the middle of the night via Vercel cron (`/api/cron/scan`).
2. **Delta sync** — sales-only update, runs every ~10 minutes via Vercel cron (`/api/cron/delta`). Does NOT re-scan products, POs, or vendor returns — only sales.
3. **Page auto-refresh** — the UI polls in the background and automatically refreshes the display when new delta sync data is available. Users never need to manually refresh the page to see new sales.

## Key Architecture

### Scan Pipeline (step.js)
Each POST to `/api/scan/step` does ~6 seconds of work and saves state to KV. Client loops until done.

Phases in order (CURRENT — as of Jun 2026):
`init` → `products_seed` → `consignments` → `returns` → `sales` → `finalizing`

The old catalog-scan phases (`products`, `products_slow`, `products_slow_done`, `products_fix`, `products_variants`) have been **removed** and replaced by `products_seed`. Do not restore them.

KV keys:
- `scan:job:{season}` — small operational state (phase, cursors, progress). On completion: `{ phase: "done", season, ts }` with 2h TTL (kept so cron skip logic works).
- `scan:job:big:{season}` — large data blobs (pidMaps, productStats) during scan, 6h TTL. Deleted after finalizing.
- `scan:data:{season}` — final report blob, 48h TTL.
- `scan:pids:{season}` — lightweight pid maps saved after each full scan: `{ seasonPids, pidToType, pidToSupplier, skuToPid, pidToPrice }`, 48h TTL. Used by products_seed to restore product maps without loading the full 5-10MB scan:data blob.

### SKU Structure
Every product SKU follows this format: `{item_code}/{season_code}{variant_number}`

Examples: `sphoenix/rs260101`, `s980621/s260108`, `stokyo/pf261`

The slash comes AFTER the item code and BEFORE the season code. The variant number is appended directly to the season code with no separator.

Season codes (2 digits at end = year):
- `s26` — Spring 2026
- `f26` — Fall 2026
- `rs26` or `ps26` — Pre-Spring (2027+)
- `pf26` — Pre-Fall (2027+)

**Season breakdown by year:**
- **2025 & 2026:** Spring and Fall only. Pre-season was combined into the main season because of the hard pull from the old system. No separate PreSpring or PreFall seasons exist for these years.
- **2027+:** All four seasons — PreSpring, Spring, PreFall, Fall

**Important:** For 2025 & 2026, products with `rs26`/`ps26` codes are counted under Spring, and products with `pf26` codes are counted under Fall. The scan must capture all of these codes for the correct season.

### Product Identification — products_seed phase
Products are discovered from three targeted sources (in order, deduplicating by PID):

1. **Prior scan** (`scan:pids:{season}` KV key) — restores `seasonPids`, `pidToType`, `pidToSupplier`, `skuToPid`, `pidToPrice` directly. No API calls. Fastest path when prior data exists.
2. **Datatail override SKUs** (`scan:override:{season}:v:*` in KV) — `style` field = full LS SKU (e.g. `cafmrhalo/s2601`). Derives handle by removing the slash (`cafmrhalos2601`) and looks up via `?handle=`. Only fetches handles NOT already in skuToPid.
3. **LS PO line items** (lazy registration during consignments phase) — when a product appears in a PO but wasn't found by sources 1 or 2, fetches it by ID and checks its SKU against season codes before registering.

**Key facts:**
- Products exist in BOTH old system (datatail) and new LS POs — no clean dividing line
- Deduplication is automatic: `registerProduct` is a no-op if the PID is already in `seasonPids`
- `state.negPids` caches non-season product IDs to avoid re-fetching on each step call
- `pidToPrice` is critical for retVal/retCost in the returns phase — always save it to `scan:pids`

### Data Flow — Bottom Up (CRITICAL)
All totals are calculated at the individual product/SKU level first, then flowed up through each report level. Never calculate totals top-down.

Flow: **individual product SKU → vendor total → department total → season summary**

Each level's numbers are the sum of the level below it. If a number looks wrong at the vendor or department level, the root cause is always at the product level. Fix it there and it propagates up automatically.

### productStats — single source of truth
`productStats[pid] = { ordered, orderedCost, received, receivedCost, retVal, retCost, retQty, soldAmt, saleAmt, sold, onSale, returned }`

- `retQty` = vendor return quantity (from RETURN consignments). Displayed in the Returned column.
- `retVal` / `retCost` = vendor return retail/cost dollars. Used in header totals.
- `returned` = customer return quantity from sales. **Never displayed in the Returned column.** Kept only for future on-hand reconciliation indicator.
- `sold` and `onSale` are mutually exclusive (discounted sales go ONLY to onSale, not both)
- Customer returns subtract from whichever bucket the item sold from (discounted → onSale, full price → sold). They do NOT affect `retQty` or the Returned column.
- `saleAmt` = actual discounted sale dollars (used in color key, NOT retail price × qty)
- `soldAmt` = net sale dollars (can be negative for net-return products)

### Override / Datatail Vendors — Special Notes
- Override products (datatail import) may have `pidToPrice[pid] = 0` if the LS API didn't return a retail price for those products. This causes `retVal = 0` in the returns phase.
- **Fix (Jun 2026, data.js):** `computeReturnedFromSkus` falls back to `override_product.price × retQty` when `retVal = 0` but `retQty > 0`. This ensures the Returned (retail) header is correct for consignment/datatail vendors.
- Consignment vendors (e.g. Judi Powers) have `receivedCost = 0` because no upfront cost is charged. LS may still record a cost on their return consignments. **Do not show negative Received (cost) — cap at $0.**

### Cron / Scan Loop
- `vercel.json` cron fires nightly: `GET /api/cron/scan`
- UI "Sync from LS" button POSTs to `/api/cron/scan` in a loop
- First call: `?force=1&restart=1` — restarts all seasons fresh
- Subsequent calls: `?force=1` — advances in-progress seasons, skips seasons completed within 1 hour
- Concurrency: 3 seasons at a time (avoids LS rate limits)
- 429/503 from LS: exponential backoff, up to 4 retries (2s, 4s, 8s, 16s)
- cron/scan and cron/delta maxDuration: 300s; step.js: 60s
- UI scan loop retries on HTTP 500 and 503 (8s wait) — a single transient error no longer stops the whole scan
- On completion, `scan:job:{season}` is kept as `{ phase: "done", ts }` (2h TTL) so the skip-interval check works

### Delta Sync
Separate sales-only sync at `/api/cron/delta`, runs ~every 10 minutes. Only updates sales — does NOT re-scan products, POs, or returns. DO NOT break this when changing the product scan logic.

## Seasons
Generated in `lib/seasons.js`. Current year + 1 ahead, back to 2025.
- 2025: fall25, spring25 (no pre-seasons)
- 2026: fall26, spring26 (no pre-seasons — transition year)
- 2027+: fall, prefall, spring, prespring

**2027 seasons have no orders yet** — they should complete quickly with empty data (not error). They now complete correctly and do not repeat.

Active seasons for scanning: current year, next year, prior year.

## Current State (Jun 10, 2026)
The scan pipeline is working end-to-end. Key things confirmed working:
- products_seed restores ~7000+ products from scan:pids without API calls on second+ run
- Ordered qty (qtyOrdered) flows correctly from LS POs to product rows
- Vendor returns: retQty shows in Returned column per product
- 2027 seasons complete with empty data and do not repeat
- UI scan loop retries on 500/503 — won't stop prematurely on transient errors
- scan:job kept on completion so cron interval check works correctly
- Nightly workflow uses ?restart=1 on first call to force fresh rescan past 1-hour interval

## Vendor Header — How Totals Are Computed (Jun 10, 2026)
All numbers in the vendor product drilldown header are computed from the individual product rows using live prices fetched from LS. This guarantees the header always matches the product list and color key, regardless of any scan-time price computation issues.

Formulas (per product row, summed across all products):
- **Ordered (retail)** = sum(qtyOrdered × price)
- **Ordered (cost)** = sum(qtyOrdered × cost)
- **Received (retail)** = sum((onHand + sold + onSale) × price)
  — this is net received: items received minus vendor returns (returned items are not in any of onHand/sold/onSale)
- **Received (cost)** = sum((onHand + sold + onSale) × cost − returned × cost), capped at $0
- **Returned (retail)** = sum(returned × price)
- **Sold (retail)** = sum(sold × price) — full-price sales only; on-sale items are tracked separately in the color key

Note: the vendor LIST table and store SUMMARY still use scan:data aggregated values. These should match the above for most vendors but may differ if the scan had price computation issues for specific variant products.

## Known Remaining Issues
1. **Staud spring26 return** — Carrie may have entered a return in the wrong season. Needs investigation.
2. **Ordered (cost) = $0 for datatail-only vendors** — no LS cost data on old RMH POs. Data gap, not a code bug. Spring 2026 ordered cost is low for this reason.
3. **scan retVal still 0 for some LS-native variant products** — the vendor header now bypasses this via live product computation, but scan:data still stores 0 for returned retail on these products. Vendor list and store summary RETURNED column may undercount for those vendors until the scan price computation is fixed.

## Stable Checkpoint — Revert Instructions
If the scan breaks again, the last known-good commit is the one that merged `Fix Returned (retail) header for datatail-only vendors` to main (Jun 7, 2026). To find it:
```
git log --oneline main | head -5
```
The key files and their roles:
- `pages/api/scan/step.js` — full scan pipeline. `products_seed` phase is the critical product-discovery logic.
- `pages/api/scan/data.js` — merges override (datatail) data with LS scan data at request time. `computeReturnedFromSkus` handles returned retail for datatail vendors.
- `pages/api/cron/scan.js` — orchestrates season scanning, skip logic, concurrency.
- `pages/api/cron/delta.js` — sales-only delta sync, runs every ~10 min.
- `pages/index.js` — UI, scan loop (retries on 500/503).

## UI Behavior
- Season navigation: changing seasons keeps the user on the same drilldown view (dept or vendor). Falls back to dept list if vendor doesn't exist in new season, falls back to summary if dept doesn't exist.
- Color key uses actual `saleAmt` for on-sale items (not retail price × qty).
- Sold column: full-price sales only. On Sale column: discounted sales only.
- **On-sale visual highlighting** (DEFERRED): in the old RMH system, items on sale had different font color in the product list. We will replicate this in LS using pricebooks — come back to this once the pricebook workflow is settled in LS.

## What NOT To Do
- Do not remove the 6h KV TTL on scan:job:big (was 1h before, caused state loss on long scans)
- Do not delete scan:job on completion — keep it with `{ phase: "done", ts }` so the 1-hour rescan interval check works
- Do not restore the old catalog-scan phases (products, products_slow, etc.) — they timed out on 110k+ products
- Do not scan all products for 2027 seasons — they complete gracefully with empty data
- Do not put discounted items in both Sold and On Sale columns
- Do not use retail price in the color key for on-sale items — use actual saleAmt
- Do not break the delta sync when modifying the full scan logic
- Do not assume all POs are in LS — some came from the datatail import
- Do not use supplier ID for brand matching — multiple brands share one LS supplier ID; match by SKU
- Do not show negative Received (cost) — cap at $0 for consignment vendors

## Code Quality & Style Guidelines (AI MUST follow)
These rules apply to ALL code the AI writes or edits in this repo. They are enforced (with warnings today, tightening over time) by ESLint + Prettier — see `.eslintrc.json` and `.prettierrc.json`.

### Tooling
- **Formatting:** Prettier owns formatting. Run `npm run format` before committing; never hand-format. Config: 2-space indent, double quotes, semicolons, 100-char width, trailing commas (es5).
- **Linting:** `npm run lint` (`next lint`). It MUST pass with zero ESLint **errors** before pushing. Warnings should trend toward zero — never add new warnings in code you touch.
- Do NOT add a root `babel.config.js` — it disables Next's SWC compiler. Jest transforms come from `next/jest` in `jest.config.js`.

### Style rules
- **`const`/`let` only — never `var`.** Prefer `const`; use `let` only when reassignment is required. (Legacy `var` in `pages/index.js` is grandfathered as warnings; convert opportunistically when editing nearby code, but do NOT do a giant unrelated reformat that collides with the other agent.)
- Use `===`/`!==` (smart `eqeqeq`) — avoid loose equality except the `== null` null/undefined check.
- No leftover `console.log` (`console.warn`/`console.error` are allowed for genuine diagnostics).
- No unused variables. Prefix intentionally-unused args/vars with `_`.
- Keep functions small and pure where possible. Pull pure logic into `lib/` modules (like `lib/flow-math.js`, `lib/seasons.js`) so it is unit-testable in isolation.
- Comments explain non-obvious intent, trade-offs, or domain constraints (e.g. the LS/datatail netting rules) — not what the code literally does.
- Respect the existing architecture and the "What NOT To Do" list above. Style cleanups must never change behavior.

## Testing Policy (AI MUST follow)
Unit tests are a default deliverable, not an afterthought.

### Write tests by DEFAULT for everything
- For **every** new function, bug fix, or behavior change, the AI MUST add or update unit tests in the same change. "Done" means code **and** its tests.
- Prefer extracting business logic into pure functions under `lib/` and testing it directly. This is how the flow-report math (ordering, receiving, vendor returns, sales/on-sale netting, on-hand) should be verified — at the individual-SKU / product level, matching the bottom-up data flow described above.
- Each bug fix gets a regression test that fails before the fix and passes after.
- Test the real domain rules, not trivial getters. Good targets: season/SKU matching, sale-vs-on-sale classification, customer-return handling, netting of received/returned totals, header total formulas.
- Tests live in `__tests__/` folders next to the code (e.g. `lib/__tests__/seasons.test.js`) or as `*.test.js`. Use `next/jest` (already configured). Default env is `node`; add a `@jest-environment jsdom` docblock for React component tests.
- Mock external I/O (Vercel KV, the Lightspeed API, `fetch`). Never hit live LS or KV from a unit test.

### Run tests BEFORE pushing
- The AI MUST run `npm test` and confirm it is green **before every push**. Do not push with failing or skipped tests.
- Required pre-push gate (all must pass): `npm test` → `npm run lint` (zero errors) → `npm run build` for changes that affect the build.
- If a test is intentionally pending, mark it `it.todo(...)` or `test.skip` with a comment explaining why — never leave silently broken tests.
- CI/local equivalent: `npm run test:ci`.

### Expanding test coverage
The lint/test scaffold is on `main`. Keep new tests focused on stable, pure modules under `lib/` (e.g. `lib/flow-math.js`, season/SKU matching, sale-vs-on-sale classification) and add regression tests as scan pipeline logic settles.
