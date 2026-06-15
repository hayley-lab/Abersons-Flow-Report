# Abersons Flow Report — Project Context

## Handoff / Onboarding

- Start with `README.md` for local setup, env vars, scripts, deployment/sync entry points, and the documentation map.
- Use `docs/flows.md` for visual maps of old-to-new lineage, scan phases, sync paths, rollup merging, and sale classification.
- This file remains the source of truth for domain rules, AI maintenance constraints, testing policy, and known risks.

## Git Workflow

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
fix(scan): record vendor returns using RETURN consignment type
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
- Next.js pages router (package currently Next 16)
- Vercel KV (Redis/Upstash) for scan state and cached results
- Iron-session for auth
- Lightspeed Retail API v2 (`https://{LS_DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0/`)

## How The Data Is Supposed To Work (Hayley's Spec)

### 1. Hard Pull (datatail import)
Old PO ordered/received data that never made it into LS was imported directly into the app (via `pages/api/import/datatail.js`). This covers ordered & received quantities and dollars from the RMH era. These amounts must ADD to any matching LS POs — they must not be double-counted or overwritten.
- **Permanent baseline (Jun 2026):** the override is written WITHOUT a TTL (`scan:override:{season}:*`). It used to expire after 30 days, which silently dropped imported returns/orders and regressed the report. Re-importing overwrites/merges in place. See `pages/api/import/save.js` and `datatail.js`.
- **Staud spring26 return — RESOLVED (Jun 2026):** verified directly in RMH. PO #5526 "staud consignment return" (94 units, $15,012 cost) is correctly spring26 — all line-item SKUs carry the `s26` code. The "wrong season" worry came from the PO's `DatePlaced` (2026-05-05, a fall date) vs its `RequiredDate`/SKUs (spring). No correction needed.

### 2. LS POs (consignments in LS API, type=SUPPLIER)
Pull ordered and received quantities and dollars from LS purchase orders. These go into the Ordered and Received columns. Must not collide with the hard pull data.
- Ordered/Received qty in designated columns (qty, not dollars)
- Retail $ summed into color key and pushed to header
- Cost $ also shown in header
- When a product is received, it adds to both the Received column AND the On Hand column
- Partial receipts work correctly — LS tracks ordered qty and received qty separately per PO line item, so if 2 are ordered and 1 comes in, ordered shows 2 and received shows 1

**On Hand (product level):** Pulled directly from LS live inventory count — NOT calculated from a formula. This is accurate because LS updates its inventory in real time when items are received, sold, returned, or sent back to vendor. Formula for reference: `received qty − vendor returns − sold − on sale + customer returns` — but LS handles this internally.

**Caveat:** If inventory is manually adjusted in LS (e.g. during a physical inventory count or a manual correction), the on-hand count in the flow report will reflect that adjustment. This means on-hand can diverge from what the received/sold/returned columns would mathematically imply. This is expected behavior — LS is the source of truth for inventory. Worth noting to staff: manual LS inventory adjustments will show up here.

**On-hand reconciliation indicator (IMPLEMENTED Jun 2026):** When the LS on-hand qty doesn't reconcile with the derived flow stock (`received − vendor returns − sold − on sale`), a small `≠` icon + tooltip shows next to the on-hand number in the product table. The materially-different count is surfaced on Data Health ("Manual-count differences"), gated to `MATERIAL_UNIT_DELTA`/`MATERIAL_DOLLAR_DELTA`. Consignment/migrated no-PO products (`qtyReceived === 0`) are excluded. See the "Manual-count differences" subsection below.


### 3. Vendor Returns (consignments in LS API, type=`RETURN`)
> NOTE (Jun 15, 2026): the LS X-Series consignment type for a vendor return is **`RETURN`** (the other types are `SUPPLIER`, `OUTLET`, `STOCKTAKE`). Earlier docs/tooling said `SUPPLIER_RETURN`, which does not exist in this API and silently returns nothing — `pages/api/scan/step.js` correctly uses `RETURN`.

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
- RETURNED column = items physically sent back to the vendor (vendor returns, type=`RETURN` consignments in LS)
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
- `scan:job:big:{season}` — large data blobs (pidMaps, productStats) during scan, 72h TTL. Stored through the sharded KV helper (`lib/kv-sharded.js`) as a small marker plus per-PID shard keys (`:shard:{i}`), with an 8MB preflight size guard. Deleted after finalizing, including its shards.
- `scan:data:{season}` — final report data, 48h TTL. Stored sharded by PID with the same helper; loaders still return the legacy monolithic shape to callers and transparently read old unsharded production values.
- `scan:pids:{season}` — lightweight pid maps saved after each full scan: `{ seasonPids, pidToType, pidToSupplier, skuToPid, pidToPrice, pidToSku }`, 48h TTL. Stored sharded by PID and used by products_seed to restore product maps without loading full report data.
- Large store-wide helper caches that can exceed a safe KV request size (`scan:inv:store` and `scan:catalog:season:{season}`) are also sharded by PID. Public loaders preserve the old `{ byOutlet, onHand }` inventory shape and scan:pids-shaped catalog bucket shape, and legacy monolithic values remain readable until rewritten by the next sync.

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

1. **Prior scan** (`scan:pids:{season}` KV key) — restores `seasonPids`, `pidToType`, `pidToSupplier`, `skuToPid`, `pidToPrice`, and `pidToSku` directly. Restored pids are SKU-gated when the SKU is known (`skuMatchesSeason(pidToSku[pid], season)`); unknown-SKU pids still restore so older caches and later metadata backfill remain compatible. No API calls. Fastest path when prior data exists.
2. **Datatail override SKUs** (`scan:override:{season}:v:*` in KV) — `style` field = full LS SKU (e.g. `cafmrhalo/s2601`). Derives handle by removing the slash (`cafmrhalos2601`) and looks up via `?handle=`. Only fetches handles NOT already in skuToPid.
3. **LS PO line items** (lazy registration during consignments phase) — when a product appears in a PO but wasn't found by sources 1 or 2, fetches it by ID and checks its SKU against season codes before registering.

**Key facts:**
- Products exist in BOTH old system (datatail) and new LS POs — no clean dividing line
- Deduplication is automatic: `registerProduct` is a no-op if the PID is already in `seasonPids`
- `state.negPids` caches non-season product IDs to avoid re-fetching on each step call
- `pidToPrice` is critical for retVal/retCost in the returns phase — always save it to `scan:pids`
- Product-to-vendor attribution is brand-primary for LS products: use `vendorIdentityFromLs` (`brand`/`brand_id` first, then supplier fallback, then Unknown). Datatail SKU overrides still win over LS identity because imported vendor rows can intentionally correct attribution.
- Store-wide consignment projection uses the union of `scan:catalog:season:{season}.seasonPids` and prior `scan:data:{season}.seasonPids`; this keeps same-season consignment-only/archived products while the SKU gate prevents wrong-season drift.

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
- Customer returns subtract from whichever bucket the item sold from (discounted → onSale, full price → sold). Discounted return lines also subtract from `saleAmt` using the negative refund amount so a discounted sale + return nets on-sale dollars back to $0. They do NOT affect `retQty` or the Returned column.
- `saleAmt` = actual discounted sale dollars net of discounted customer returns (used in color key, NOT retail price × qty)
- `soldAmt` = net sale dollars (can be negative for net-return products)

### Override / Datatail Vendors — Special Notes
- Override products (datatail import) may have `pidToPrice[pid] = 0` if the LS API didn't return a retail price for those products. This causes `retVal = 0` in the returns phase.
- **Root-cause fix (Jun 2026, step.js):** `registerProduct` now upgrades `pidToPrice`/`pidToCost` from $0 to a real catalog price (`preferPositive` in `lib/flow-math.js`) instead of locking in the first value — a $0 first-seen price no longer poisons every dollar column for that pid.
- **Request-time fallback (Jun 2026, flow-rollup.js):** `buildAllRows` maps each LS-matched pid to the datatail import's `op.price`/`op.cost` (via `skuToPid`) and uses it when the catalog price is $0 (no live LS fetch in the request path). This keeps Returned/Received retail and cost non-$0 for consignment/datatail vendors. The color key (`pages/index.js`) and the Returned (retail) header both use `returnedRetailValue`, so they always agree. (The old `computeReturnedFromSkus`/`override-merge.js` helpers were removed.)
- **Season gate (Jun 2026, flow-rollup.js):** override products are filtered by `skuMatchesSeason` (folding rs/ps→spring, pf→fall for 2025/26) in both `buildAllRows` and the vendor-level ordered fold, so a datatail import done while on the wrong season cannot pollute another season's totals.
- **Mixed LS/datatail Ordered (retail + cost) (Jun 2026):** vendor ordered dollars are LS PO ordered plus datatail ordered dollars only for override SKUs with no LS PO/return activity. Overlapping SKUs stay LS-only to avoid double-counting; old override rows without usable per-product ordered dollars fall back to the guarded vendor-level combine. Ordered cost follows the same overlap rule and is calculated from imported product `qtyOrdered × cost` (or a reliable matched LS row cost) when available; missing costs stay a data gap instead of being fabricated.
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

## Vendor Header — How Totals Are Computed (Jun 2026)
All numbers in the vendor product drilldown header, vendor list, and store summary read the same request-time `lib/flow-rollup.js` output. This guarantees the header matches the list row and product rows instead of diverging through separate math paths.

Formulas (per product row, summed across all products):
- **Ordered (retail)** = sum(qtyOrdered × price)
- **Ordered (cost)** = LS PO sum(qtyOrdered × cost), plus imported/datatail product `qtyOrdered × cost` for non-overlapping override SKUs when product-level cost is available.
- **Received (retail)** = sum(receivedUnits × price), where `receivedUnits = qtyReceived − retQty` (PO `qtyReceived` net of vendor returns). **Consignment/migrated fallback:** when `qtyReceived === 0` (consignment or goods migrated with no LS PO record), `receivedUnits` falls back to the live-derived `onHand + sold + onSale`.
  — still net received (returns subtracted); now driven by the PO rather than live on-hand, so a manual LS on-hand edit can't distort Received or sell-through. (`lib/flow-math.js` `netReceivedUnits`.)
- **Received (cost)** = sum(receivedUnits × cost), capped at $0 (consignment vendors have cost 0 → $0).
- **Returned (retail)** = sum(returned × price)
- **Sold (retail)** = sum(sold × price) — full-price sales only; on-sale items are tracked separately in the color key

**On Hand stays live:** the On Hand column is still sourced directly from LS live inventory (`displayOnHand`/`liveOnHand`), never recomputed. Only the Received column and the Received%/Sold% denominators changed to PO-based.

**Why (Jun 2026, Q2):** the old `netReceivedUnits = onHand + sold + onSale` meant a manual LS on-hand correction (physical count, manual adjustment) silently moved Received and sell-through. Received now reads the PO's `qtyReceived` (net of `retQty`); consignment/migrated products with no PO keep the live-derived fallback so they don't show 0 received or get falsely flagged as adjustments.

Note: the vendor LIST table and store SUMMARY read the same `lib/flow-rollup.js` rollup, so they always agree with the drilldown header.

### Validation / Data Health (Jun 2026)
- `/api/scan/validate` now samples only fresh live on-hand LS product calls. Cache-only checks for LS POs, vendor returns, sales, and rollup/header dollar invariants run across all verifiable rows, so nightly validation can be broad without thousands of product inventory calls.
- Data Health reports coverage percentages: datatail-only rows, manual-count differences, on-hand sampled %, cache-checked %, retail verified %, rollup dollar mismatches, and data-gap counts. A green validation badge means "within threshold for the reported coverage", not that every historical/datatail dollar is independently LS-verifiable.
- Rollup failures surface as `rollupDegraded`/`totalsDegraded` with a visible warning banner; do not trust fallback totals until Data Health is checked and the rollup error is fixed.
- Deep validation that re-pages LS sales/consignments live is still deferred. Current validation re-projects the store caches independently from `scan:data`, but it does not prove the caches themselves are complete.

### Manual-count differences (`≠`) — demoted + gated (Jun 2026, Q1)
- The per-product `≠` icon + tooltip stays in the product table (LS on-hand differs from the flow math → usually a Lightspeed inventory count/correction; LS is the source of truth).
- The old vendor-header `≠ N adjusted` pill was **removed**. The count now lives on the **Data Health** screen ("Manual-count differences"), reworded away from "adjusted" toward "counts reconciled in Lightspeed".
- The count is **gated to MATERIAL deltas** via named constants in `lib/health-status.js`: `MATERIAL_UNIT_DELTA = 2` and `MATERIAL_DOLLAR_DELTA = 25`. A product counts only when `|live − derived| ≥ 2` units OR `|delta| × price ≥ $25` (`isMaterialMismatch`/`adjustedCount`).
- Consignment/migrated no-PO products (`qtyReceived === 0`) are never flagged: `mismatchDerivedStock`/`derivedFlowStock` track live on-hand for them (Q1b).

### Zero-activity vendors hidden (Jun 2026, Q3)
The vendor list and the department summary list in `pages/index.js` hide rows where `ordered === 0 && sold === 0` (legacy datatailor omitted no-activity vendors). The greyed-zero row styling was removed since those rows no longer render.

### "Other" department → Data Health (Jun 2026, Q4)
"Other" = uncategorized LS products (`deptId === "__none__"`, i.e. no `product_type_id`). Its summary row is clickable and opens the Data Health screen, which lists those products (SKU, vendor, season, ordered/received/sold qty via the pure `uncategorizedRows(rows, season)` helper) so staff can assign product types in Lightspeed.

### RMH + LS vendor returns — report shows the deduped union (Jun 2026; corrected Jun 15)
Vendor returns are entered in **both** systems during the RMH→LS transition: historical/transition returns in RMH (`POType=3`, dated 2024-10 → 2026-05-28) and new returns in LS (`type=RETURN` consignments, dated 2025-12-19 →). Steve's "returns not showing out of the new report" was the **RMH-only** tail (returns LS never had). The report surfaces the **union** of both, deduped:
- **LS returns** are captured by the scan into `productStats.retQty` (step.js `fetchConsignmentHeaders("RETURN")`). This part always worked.
- **RMH-only returns** are backfilled into the durable override (`scripts/backfill-rmh-returns.mjs`, LOCAL/LAN one-off; `--write` persists) and injected by `lib/flow-rollup.js` `overrideReturnsByPid`: for an LS-matched pid where LS records no return (`retQty === 0`), the override's `qtyReturned` is surfaced (Returned column + Received netting). **LS wins per pid** when `retQty > 0`; we take the **MAX per pid** across override records (the datatailor hard pull and the RMH backfill share the same RMH source — summing would double-count).
- **Verified (Jun 15) via the rollup-replay harness `tools/recon-accuracy.js`:** spring25/fall25 have no LS returns → report == RMH exactly (1,175u / 167u). spring26 = 652u = 142u overlap (same SKUs in both, LS 142u ≈ RMH 140u → deduped, NOT summed) + 115u LS-only + 395u RMH-only. So the report is the correct deduped union; comparing it to RMH-`POType=3`-alone (535u) is comparing against an incomplete source. fall26 = 9u, all LS (RMH has none).
- **Earlier false premise (now corrected):** a reconciliation script and these docs queried the non-existent LS type `SUPPLIER_RETURN` and concluded "LS has 0 returns." That was wrong — the type is `RETURN`. The 4e backfill is still correct and necessary (it adds the RMH-only tail), and the per-pid LS-wins/max guard prevents double-counting the transition overlap.
- **Workflow going forward (CONFIRMED by owner, Jun 15):** vendor returns are entered in **Lightspeed only** (`RETURN` consignment) from now on, so the report picks them up automatically. The RMH backfill is a frozen, one-time historical/transition tail — the LS↔RMH overlap will not grow, so the per-pid LS-wins/max dedup fully handles it going forward.

### Full RMH↔report accuracy reconciliation (Jun 15, 2026)
`tools/recon-accuracy.js` replays the **real** request-time rollup (`lib/flow-rollup.js`) against live KV and diffs every RMH-era season against RMH source-of-truth (`tsql`) and the frozen RMH snapshot (`scripts/rmh-snapshot.mjs`). Run: `npx jest --runTestsByPath tools/recon-accuracy.js --testMatch "**/tools/recon-accuracy.js"` (LAN only). Verdict by column:

- **Returned — VERIFIED.** Report == deduped union of LS returns + RMH-only returns, Δ=0 across all four seasons (see returns section above).
- **Ordered $ — reconciled; one known source gap.** Reconciled in **dollars at the `rollup()` level** (LS PO ordered + datatail vendor-level ordered via `combineDollarValue`), per-SKU/crossover-aware — NOT a row-unit sum. fall25 reconciles to RMH within 3.4%. **spring25 is ~$1.6M (34%) under RMH** (report/datatailor $3.14M vs RMH placed `POType=0` $4.74M retail / $1.99M cost). The combine is **correct** (report == full datatailor vendor-level total); the shortfall is in the **historical datatailor hard-pull** itself (the legacy scrape was incomplete) and is neither a cost/retail mix-up nor unplaced POs (all spring25 POs are `IsPlaced=1`). spring26/fall26 are the crossover — report = LS + RMH-only datatail deduped, so a raw RMH-all comparison is expected to differ (informational). See Known Issue #1 below.
- **Ordered-overlap bug FIXED (`hasLsPoActivity`).** A vendor RETURN no longer counts as "LS owns the ordered" — that wrongly dropped datatail ordered for return-only RMH-era products (recovered ~$331k on spring26). Returned dollars are reconciled separately.
- **Received — LS-sourced post-crossover.** Driven by LS PO `qtyReceived` (net of returns) with the consignment/migrated live-derived fallback. RMH's PO `QuantityReceived` is 0 across the board, so Received is not reconcilable against RMH — LS is source of truth.
- **Sold / On-sale — mostly aligned; closed-season migration gap.** vs the RMH snapshot: spring26 +1.1% (OK). spring25 −9.9% and fall25 −11.5% — the report is **lower** because not all early-season RMH sales (before the LS migration cutover) were migrated into LS. This is an **LS data-migration completeness** gap on closed seasons, not a report-code bug. fall26 is higher (current LS-era season; LS is the live source).
- **On hand — live from LS** (source of truth; `≠` indicator surfaces divergences). Not a reconciliation target.

**Frozen RMH snapshot:** `scripts/rmh-snapshot.mjs` exports POs (type 0/3 with status), per-SKU sales, and a season summary to `scripts/out/rmh-snapshot-<date>/` (gitignored — supplier names + costs). RMH access ends at handoff, so this is the source-of-truth backup for any later reconciliation/backfill. Re-run before handoff and copy somewhere safe.

## Known Remaining Issues
1. **Ordered (cost) data gaps — measured + largely closed (Jun 15, 2026)** — a full LS catalog scan (261k product records) intersected with RMH `POType=0` cost data proved **Lightspeed already carries `supply_price` for ~99% of active-season products** (23,683 of 23,929). The KPI `orderedCostGap` is therefore driven by RMH/datatail-only ordered rows (POs that never migrated to LS — no LS product to read a cost from), plus transient scan cost-capture lag (`COST_BACKFILL_PER_SCAN = 200` in `step.js` fills `pidToCost` over successive scans). Closed via two fixes: (a) the durable KV cost-override baseline (`scripts/backfill-rmh-ordered-cost.mjs`, cost-only fallback for RMH `POType=0` SKUs) for the datatail-only rows; (b) only **5** active-season products were $0 in LS *and* fillable from RMH — 4 were injected into LS `supply_price` (`scripts/inject-ls-cost.mjs`, fill-only) and 1 (`n12088/pf260104`) lacks an LS supplier and is flagged for manual entry. Residual `orderedCostGap` is now genuine no-cost-anywhere rows (consignment / non-purchased) and stays disclosed via the KPI.
2. **scan retVal still 0 for some LS-native variant products** — scan:data may still store 0 for returned retail on these products. This is now mitigated end-to-end at request time: `registerProduct` upgrades a $0 `pidToPrice`/`pidToCost` to the real catalog price, and `buildAllRows` falls back to the datatail `op.price`/`op.cost` for matched rows, so the vendor list, store summary, and drilldown header (all derived from the same rollup) use `returnedRetailValue`/`returnedCostValue` rather than a stored 0.
3. **Customer return bucket inference is heuristic** — the classifier uses return-line discount fields, pricebook markers, zero-dollar lines, and unit-vs-retail comparison. LS *does* expose the original-sale link on return sales as `sale.return_for` (+ `sale.return_ids`) — verified against the live API; ~12% of sales are returns and carry it. A future improvement is to bucket returns by looking up the original sale instead of heuristics — see plan item 4d. Until then the heuristic stands.
4. **spring25 Ordered understated ~$1.6M (34%); closed-season sold migration gap (Jun 15, 2026)** — the historical datatailor hard-pull captured only $3.14M of spring25 ordered vs RMH's $4.74M placed-PO truth (fall25 is fine, within 3.4%). The report faithfully reflects the (incomplete) hard-pull; the combine is correct. Separately, spring25/fall25 **Sold** is ~10–12% under RMH because not all pre-cutover RMH sales were migrated into LS. Both affect **closed past seasons only**; going forward everything is LS-native and accurate. A deliberate RMH backfill of spring25 ordered is possible **while connected to RMH** (the frozen snapshot preserves the data for later), but it would overwrite the opaque legacy figure with raw RMH placed-PO totals — a business decision, not done automatically. Quantified by `tools/recon-accuracy.js`.

### Undated consignments (Jun 2026)
`seasonConsignmentBuckets` (`lib/consignment-store.js`) no longer projects an undated SUPPLIER/RETURN entry into every season whose pid set contains the pid. Undated entries can't be date-filtered, so each pid is attributed only to the unique season whose SKU set owns it; pids shared by more than one season are ambiguous and excluded (with a logged count) instead of inflating Ordered/Received/Returned across seasons. When `pidToSku` is available, both dated and undated projection are SKU-anchored: the pid must be in the season's projection set and `skuMatchesSeason(pidToSku[pid], season)` must pass. Unknown-SKU pids keep the historical pid-set fallback. The consignment cache endpoint projects from catalog pids plus prior `scan:data` pids, and the validation endpoint derives `pidToSku` from canonical rows so re-validation uses the same gate.

## Stable Checkpoint — Revert Instructions
If the scan breaks again, the last known-good commit is the one that merged `Fix Returned (retail) header for datatail-only vendors` to main (Jun 7, 2026). To find it:
```
git log --oneline main | head -5
```
The key files and their roles:
- `pages/api/scan/step.js` — full scan pipeline. `products_seed` phase is the critical product-discovery logic.
- `pages/api/scan/data.js` — runs the request-time rollup (`lib/flow-rollup.js`) that merges override (datatail) data with LS scan data. `buildAllRows` applies the datatail price/cost fallback and season gate for datatail vendors (the old `computeReturnedFromSkus` was removed).
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
These rules apply to ALL code the AI writes or edits in this repo. They are enforced (with warnings today, tightening over time) by ESLint + Prettier — see `eslint.config.mjs` and `.prettierrc.json`.

### Tooling
- **Formatting:** Prettier owns formatting. Run `npm run format` before committing; never hand-format code. Config: 2-space indent, double quotes, semicolons, 100-char width, trailing commas (es5). `.prettierignore` excludes `*.md`, so `CLAUDE.md`, `README.md`, and docs are hand-formatted.
- **Linting:** `npm run lint` (`eslint .`, using `eslint.config.mjs`). It MUST pass with zero ESLint **errors** before pushing. Warnings should trend toward zero — never add new warnings in code you touch.
- **Codacy:** Codacy is not used for this project. Do not install the Codacy CLI, run Codacy analysis, or treat Codacy as a required quality gate.
- Do NOT add a root `babel.config.js` — it disables Next's SWC compiler. Jest transforms come from `next/jest` in `jest.config.js`.

### Style rules
- **`const`/`let` only — never `var`.** Prefer `const`; use `let` only when reassignment is required.
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
