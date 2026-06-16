import { computeReport, groupRowsByDept } from "../report-compute";
import { buildAllRows, rollup } from "../flow-rollup";
import { summarizeRowsHealth } from "../health-status";

function makeScanData() {
  return {
    ts: 1,
    season: "spring26",
    seasonPids: ["p1"],
    productStats: {
      p1: { qtyOrdered: 2, qtyReceived: 1, retQty: 0, sold: 1, onSale: 0, liveOnHand: 0 },
    },
    pidToType: { p1: "d1" },
    pidToSupplier: { p1: { id: "v1", name: "Vendor One" } },
    pidToPrice: { p1: 100 },
    pidToCost: { p1: 40 },
    pidToSku: { p1: "brand/s2601" },
    pidToName: { p1: "Dress" },
    skuToPid: { "brand/s2601": "p1" },
  };
}

describe("computeReport", () => {
  it("returns rows, summary, and health matching the authoritative rollup", () => {
    const scanData = makeScanData();
    const result = computeReport(scanData, null, "spring26");

    const expectedRows = buildAllRows(scanData, null, { season: "spring26" });
    const expectedRollup = rollup(expectedRows, scanData, null, { season: "spring26" });

    expect(result.rows).toEqual(expectedRows);
    expect(result.summaryRows).toEqual(expectedRollup.summaryRows);
    expect(result.deptVendors).toEqual(expectedRollup.deptVendors);
    expect(result.health.summary).toEqual(summarizeRowsHealth(expectedRows));
    expect(typeof result.health.adjustedCount).toBe("number");
    expect(Array.isArray(result.health.uncategorized)).toBe(true);
  });

  it("returns empty-but-valid shapes when there is no data", () => {
    const result = computeReport(null, null, "spring27");
    expect(result.rows).toEqual([]);
    expect(result.summaryRows).toEqual([]);
    expect(result.health.summary.totalRows).toBe(0);
  });
});

describe("groupRowsByDept", () => {
  it("buckets rows by deptId and folds missing depts into __none__", () => {
    const groups = groupRowsByDept([
      { pid: "a", deptId: "d1" },
      { pid: "b", deptId: "d1" },
      { pid: "c", deptId: "d2" },
      { pid: "d", deptId: null },
      { pid: "e" },
    ]);

    expect(groups.d1.map((r) => r.pid)).toEqual(["a", "b"]);
    expect(groups.d2.map((r) => r.pid)).toEqual(["c"]);
    expect(groups.__none__.map((r) => r.pid)).toEqual(["d", "e"]);
  });

  it("handles empty/nullish input", () => {
    expect(groupRowsByDept(null)).toEqual({});
    expect(groupRowsByDept([])).toEqual({});
  });
});
