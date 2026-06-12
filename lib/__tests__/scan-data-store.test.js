import {
  loadScanData,
  loadScanPids,
  saveScanData,
  saveScanPids,
  scanDataKey,
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
});
