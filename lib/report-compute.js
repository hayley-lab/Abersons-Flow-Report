// Single source of truth for the request-time report computation.
//
// Both the read endpoint (pages/api/scan/data.js) and any future precompute
// path call computeReport so the cached summary/rows/health can never diverge
// from the authoritative rollup math in lib/flow-rollup.js.

import { buildAllRows, rollup } from "./flow-rollup";
import { summarizeRowsHealth, adjustedCount, uncategorizedRows } from "./health-status";

// Build the canonical per-product rows, the bottom-up summary/department/vendor
// rollup, and the cheap Data Health aggregates in one pass. Returning the health
// aggregates here means the Data Health screen never has to ship or recompute the
// full rows array.
export function computeReport(rawData, override, season) {
  const rows = buildAllRows(rawData, override, { season });
  const { summaryRows, deptVendors } = rollup(rows, rawData, override, { season });
  const health = {
    summary: summarizeRowsHealth(rows),
    adjustedCount: adjustedCount(rows),
    uncategorized: uncategorizedRows(rows, season),
  };
  return { rows, summaryRows, deptVendors, health };
}

// Partition canonical rows by department so a product drilldown can read only the
// department it needs instead of the whole season. Rows with no department fall
// into the "__none__" bucket (matches the rollup's uncategorized handling).
export function groupRowsByDept(rows) {
  const groups = {};
  for (const row of rows || []) {
    const deptId = row && row.deptId != null ? String(row.deptId) : "__none__";
    if (!groups[deptId]) groups[deptId] = [];
    groups[deptId].push(row);
  }
  return groups;
}
