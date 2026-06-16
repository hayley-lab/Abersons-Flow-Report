import {
  bumpReportEpoch,
  loadReportDeptRows,
  loadReportEpoch,
  loadReportSummary,
  loadScanData,
  loadScanDataSummary,
  loadScanPids,
  reportCacheTag,
  reportDeptKey,
  reportSummaryKey,
  saveReportDeptRows,
  saveReportSummary,
  saveScanData,
  saveScanPids,
  scanDataKey,
  scanDataSummaryFromValue,
  scanPidsKey,
} from "../scan-data-store";

function createKv() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async del(key) {
      values.delete(key);
    },
    async incr(key) {
      const next = (Number(values.get(key)) || 0) + 1;
      values.set(key, next);
      return next;
    },
  };
}

describe("scan-data-store", () => {
  it("saves and loads scan data with the legacy report shape", async () => {
    const kv = createKv();
    const data = {
      ts: 123,
      season: "spring26",
      summaryRows: [{ id: "dept1", name: "Dept" }],
      productStats: { p1: { qtyOrdered: 2, sold: 1 } },
      seasonPids: ["p1"],
      pidToType: { p1: "dept1" },
      pidToSupplier: { p1: { i: "sup1", n: "Vendor" } },
      pidToQtyOrdered: { p1: 2 },
      pidToQtyReceived: { p1: 1 },
      pidToQtyReturned: { p1: 0 },
      skuToPid: { "brand/s2601": "p1" },
      pidToPrice: { p1: 100 },
      pidToCost: { p1: 40 },
      pidToName: { p1: "Dress" },
      pidToSku: { p1: "brand/s2601" },
      pidToVariant: { p1: "Blue" },
      costDone: { p1: 1 },
      deadHandles: { missing: 1 },
    };

    await saveScanData(kv, "spring26", data);

    expect(kv.values.get(scanDataKey("spring26"))).toMatchObject({
      sharded: true,
      scalar: {
        ts: 123,
        season: "spring26",
        summaryRows: [{ id: "dept1", name: "Dept" }],
        seasonPids: ["p1"],
        deadHandles: { missing: 1 },
      },
    });
    await expect(loadScanData(kv, "spring26")).resolves.toEqual(data);
    await expect(loadScanDataSummary(kv, "spring26")).resolves.toEqual({ ts: 123 });
  });

  it("summarizes legacy and sharded scan:data values without loading shards", () => {
    expect(scanDataSummaryFromValue(null)).toBe(null);
    expect(scanDataSummaryFromValue({ ts: 456, productStats: { p1: {} } })).toEqual({ ts: 456 });
    expect(
      scanDataSummaryFromValue({
        sharded: true,
        version: 1,
        shardCount: 16,
        scalar: { ts: 789, season: "fall26" },
      })
    ).toEqual({ ts: 789 });
  });

  it("keeps scan:pids lightweight and readable from legacy values", async () => {
    const kv = createKv();
    const maps = {
      seasonPids: ["p1"],
      pidToType: { p1: "dept1" },
      skuToPid: { "brand/s2601": "p1" },
      pidToPrice: { p1: 100 },
    };

    await saveScanPids(kv, "spring26", maps);
    await expect(loadScanPids(kv, "spring26")).resolves.toEqual({
      ...maps,
      pidToSupplier: {},
      pidToCost: {},
      pidToName: {},
      pidToSku: {},
      pidToVariant: {},
      costDone: {},
    });

    const legacy = { seasonPids: ["p2"], pidToPrice: { p2: 200 } };
    kv.values.set(scanPidsKey("fall26"), legacy);
    await expect(loadScanPids(kv, "fall26")).resolves.toBe(legacy);
  });

  describe("report read-cache", () => {
    it("round-trips the summary blob and dept rows under their keys", async () => {
      const kv = createKv();
      const summary = { tag: "1:0", hasOverride: true, deptIds: ["d1"], data: { ts: 1 } };
      const deptBlob = { tag: "1:0", ts: 1, deptId: "d1", rows: [{ pid: "p1" }] };

      await saveReportSummary(kv, "spring26", summary);
      await saveReportDeptRows(kv, "spring26", "d1", deptBlob);

      expect(kv.values.get(reportSummaryKey("spring26"))).toBe(summary);
      expect(kv.values.get(reportDeptKey("spring26", "d1"))).toBe(deptBlob);
      await expect(loadReportSummary(kv, "spring26")).resolves.toBe(summary);
      await expect(loadReportDeptRows(kv, "spring26", "d1")).resolves.toBe(deptBlob);
    });

    it("defaults the epoch to 0 and increments on bump", async () => {
      const kv = createKv();
      await expect(loadReportEpoch(kv, "spring26")).resolves.toBe(0);
      await bumpReportEpoch(kv, "spring26");
      await expect(loadReportEpoch(kv, "spring26")).resolves.toBe(1);
      await bumpReportEpoch(kv, "spring26");
      await expect(loadReportEpoch(kv, "spring26")).resolves.toBe(2);
    });

    it("builds a tag from ts and epoch, tolerating nulls", () => {
      expect(reportCacheTag(1781, 2)).toBe("1781:2");
      expect(reportCacheTag(null, null)).toBe("none:0");
      expect(reportCacheTag(5, undefined)).toBe("5:0");
    });
  });
});
