// Returns report data for the requested season.
//
// This is the normal UI read path. To keep it fast it serves a write-through KV
// cache (scan:report:*) instead of re-reading the full sharded scan:data blob +
// every override vendor record on every request:
//
//   - view=summary (default): a small blob with summaryRows, deptVendors, and
//     precomputed Data Health aggregates. Powers the summary + vendor screens.
//   - view=drows&dept=ID: one department's product rows. Powers the product
//     drilldown without shipping the whole season.
//
// The cache is validated by a tag ("{scan ts}:{import epoch}"); a new scan/delta
// (new ts) or a datatail import (bumped epoch) makes the next read a miss, which
// recomputes via the single authoritative path (lib/report-compute.js) and
// writes the cache back. Only the first viewer after a change pays the full cost.
import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { computeReport, groupRowsByDept } from "../../../lib/report-compute";
import { loadOverride } from "../../../lib/override-store";
import {
  loadScanData,
  loadScanDataSummary,
  loadReportSummary,
  saveReportSummary,
  loadReportDeptRows,
  saveReportDeptRows,
  loadReportEpoch,
  reportCacheTag,
} from "../../../lib/scan-data-store";
import { getLsHealth } from "../../../lib/ls-auth";
import { maybeUpsertSqlReport, readSqlReportView } from "../../../lib/sql-report-store";
import { loadConsignMeta, loadSeasonConsignOverlay } from "../../../lib/consignment-store";

function jobView(job) {
  return job ? { phase: job.phase, progress: job.progress, error: job.error } : null;
}

// Heavy path: read the full sharded scan:data + every override vendor, run the
// authoritative rollup, then write the result back into the read-cache (a small
// summary blob plus one row group per department). Returns the freshly computed
// pieces so the caller can serve the requested view without a second read.
async function rebuildReportCache(season, tag, reportTs) {
  const [rawData, override] = await Promise.all([
    loadScanData(kv, season),
    loadOverride(kv, season),
  ]);
  if (!rawData && !override) return { empty: true, hasOverride: false };

  // Live consignment overlay: re-project this season's ordered/received/returned
  // from the LS consignment store so the report reflects newly-entered POs the
  // baked scan:data may not yet carry. Best-effort — fall back to scan:data on
  // any read/projection error.
  let consignByPid = null;
  try {
    const overlay = await loadSeasonConsignOverlay(kv, season, {
      seasonPids: rawData?.seasonPids || [],
      pidToSku: rawData?.pidToSku || {},
    });
    // An empty overlay means the store was unavailable/empty; fall back to the
    // baked scan:data rather than zeroing every LS pid's ordered/received.
    consignByPid = overlay && Object.keys(overlay).length ? overlay : null;
  } catch (e) {
    console.warn("consignment overlay skipped", e.message);
    consignByPid = null;
  }

  const { rows, summaryRows, deptVendors, health } = computeReport(rawData, override, season, {
    consignByPid,
  });
  const summaryData = {
    ts: reportTs ?? rawData?.ts ?? null,
    season,
    summaryRows,
    deptVendors,
    health,
    isDelta: rawData?.isDelta || false,
    salesState: rawData?.salesState || null,
  };
  const groups = groupRowsByDept(rows);
  const deptIds = Object.keys(groups);
  const summaryValue = { tag, hasOverride: !!override, deptIds, data: summaryData };

  await Promise.all([
    saveReportSummary(kv, season, summaryValue),
    ...deptIds.map((deptId) =>
      saveReportDeptRows(kv, season, deptId, {
        tag,
        ts: summaryData.ts,
        deptId,
        rows: groups[deptId],
      })
    ),
    maybeUpsertSqlReport(season, rawData, override, { consignByPid, reportTs }).catch((e) => {
      console.warn("sql report write skipped/failed", e.message);
      return null;
    }),
  ]);

  return { empty: false, hasOverride: !!override, summaryValue, groups, rows };
}

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { season } = req.query;
  if (!season) return res.status(400).json({ error: "season required" });

  const view = req.query.view || "summary";
  const deptId = req.query.dept != null ? String(req.query.dept) : null;

  // Cheap reads only: scan ts (marker), job, import epoch, LS health, and the
  // consignment store version (so a store refresh invalidates the read-cache and
  // the live consignment overlay is recomputed). None touch the heavy shard reads.
  const [summaryMeta, job, epoch, lsHealth, consignMeta] = await Promise.all([
    loadScanDataSummary(kv, season),
    kv.get(`scan:job:${season}`),
    loadReportEpoch(kv, season),
    getLsHealth(),
    loadConsignMeta(kv).catch(() => null),
  ]);
  const scanTs = summaryMeta?.ts ?? null;
  const consignVersion = consignMeta?.ts ?? null;
  const reportTs = Math.max(Number(scanTs) || 0, Number(consignVersion) || 0) || null;

  // Poll short-circuit: nothing newer than the client already has.
  const since = req.query.since ? Number(req.query.since) : null;
  if (since && reportTs && reportTs <= since && (!job || job.phase === "done")) {
    return res.json({
      data: null,
      job: jobView(job),
      hasOverride: undefined,
      lsHealth: lsHealth || null,
      notModified: true,
    });
  }

  const tag = reportCacheTag(scanTs, epoch, consignVersion);

  try {
    // ── SQL read path (feature flagged) ──────────────────────────────────────
    // Keep the KV path as the fallback/oracle during the migration. SQL reads use
    // the same view contract as the KV read-cache: summary, drows, or full.
    const sqlData = await readSqlReportView({ season, view, deptId }).catch((e) => {
      console.warn("sql report read failed; falling back to KV", e.message);
      return null;
    });
    if (sqlData && Number(sqlData.ts) === Number(reportTs)) {
      const { hasOverride: sqlHasOverride, ...sqlDataView } = sqlData;
      return res.json({
        data: view === "drows" ? { ...sqlDataView, ts: reportTs } : sqlDataView,
        job: jobView(job),
        hasOverride: !!sqlHasOverride,
        lsHealth: lsHealth || null,
        rollupDegraded: false,
        totalsDegraded: false,
        source: "sql",
      });
    }

    // ── Cache hit ────────────────────────────────────────────────────────────
    if (view !== "full") {
      const summary = await loadReportSummary(kv, season);
      if (summary && summary.tag === tag) {
        if (view === "drows" && deptId) {
          const deptBlob = await loadReportDeptRows(kv, season, deptId);
          if (deptBlob && deptBlob.tag === tag) {
            return res.json({
              data: { ts: reportTs, season, deptId, rows: deptBlob.rows || [] },
              job: jobView(job),
              hasOverride: !!summary.hasOverride,
              lsHealth: lsHealth || null,
              rollupDegraded: false,
              totalsDegraded: false,
            });
          }
          // dept group missing/stale — fall through to rebuild.
        } else {
          return res.json({
            data: summary.data,
            job: jobView(job),
            hasOverride: !!summary.hasOverride,
            lsHealth: lsHealth || null,
            rollupDegraded: false,
            totalsDegraded: false,
          });
        }
      }
    }

    // ── Cache miss (or view=full): recompute + write-through ───────────────────
    const built = await rebuildReportCache(season, tag, reportTs);
    if (built.empty) {
      return res.json({
        data: null,
        job: jobView(job),
        hasOverride: false,
        lsHealth: lsHealth || null,
      });
    }

    if (view === "drows" && deptId) {
      return res.json({
        data: { ts: reportTs, season, deptId, rows: built.groups[deptId] || [] },
        job: jobView(job),
        hasOverride: built.hasOverride,
        lsHealth: lsHealth || null,
        rollupDegraded: false,
        totalsDegraded: false,
      });
    }

    if (view === "full") {
      return res.json({
        data: { ...built.summaryValue.data, rows: built.rows },
        job: jobView(job),
        hasOverride: built.hasOverride,
        lsHealth: lsHealth || null,
        rollupDegraded: false,
        totalsDegraded: false,
      });
    }

    return res.json({
      data: built.summaryValue.data,
      job: jobView(job),
      hasOverride: built.hasOverride,
      lsHealth: lsHealth || null,
      rollupDegraded: false,
      totalsDegraded: false,
    });
  } catch (e) {
    console.error("rollup error", e);
    return res.json({
      data: {
        season,
        ts: reportTs,
        summaryRows: [],
        deptVendors: {},
        rows: [],
        mergeError: e.message,
        rollupDegraded: true,
        totalsDegraded: true,
      },
      job: jobView(job),
      hasOverride: undefined,
      lsHealth: lsHealth || null,
      mergeError: e.message,
      rollupDegraded: true,
      totalsDegraded: true,
    });
  }
}
