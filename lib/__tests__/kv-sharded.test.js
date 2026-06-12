import {
  assertKvValueSize,
  delShardedObject,
  getShardedObjectByPid,
  jsonSizeBytes,
  setShardedObjectByPid,
  shardedKvShardKey,
} from "../kv-sharded";

function createKv() {
  const values = new Map();
  const calls = { set: [], del: [] };
  return {
    calls,
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, options) {
      calls.set.push({ key, value, options });
      values.set(key, value);
    },
    async del(key) {
      calls.del.push(key);
      values.delete(key);
    },
  };
}

describe("kv-sharded", () => {
  it("measures JSON payload size", () => {
    expect(jsonSizeBytes({ a: "b" })).toBe(Buffer.byteLength(JSON.stringify({ a: "b" })));
  });

  it("writes a marker plus PID shards and rehydrates the original shape", async () => {
    const kv = createKv();
    const value = {
      ts: 123,
      season: "spring26",
      summaryRows: [{ id: "dept1", name: "Dept" }],
      seasonPids: ["p1", "p2"],
      productStats: { p1: { sold: 1 }, p2: { sold: 2 } },
      pidToPrice: { p1: 100, p2: 200 },
      skuToPid: { "a/s2601": "p1", "b/s2602": "p2" },
    };

    await setShardedObjectByPid(kv, "scan:data:spring26", value, {
      ex: 60,
      shardCount: 4,
      pidFields: ["productStats", "pidToPrice"],
      skuToPidFields: ["skuToPid"],
    });

    const marker = kv.values.get("scan:data:spring26");
    expect(marker).toMatchObject({ sharded: true, version: 1, shardCount: 4 });
    expect(marker.scalar).toEqual({
      ts: 123,
      season: "spring26",
      summaryRows: [{ id: "dept1", name: "Dept" }],
      seasonPids: ["p1", "p2"],
    });
    expect(kv.calls.set[0].options).toEqual({ ex: 60 });
    expect(
      Array.from(kv.values.keys()).filter((key) => key.startsWith("scan:data:spring26:shard:"))
    ).toHaveLength(4);

    await expect(getShardedObjectByPid(kv, "scan:data:spring26")).resolves.toEqual(value);
  });

  it("returns legacy non-marker values unchanged", async () => {
    const kv = createKv();
    const legacy = { seasonPids: ["p1"], pidToPrice: { p1: 100 } };
    kv.values.set("scan:pids:spring26", legacy);

    await expect(getShardedObjectByPid(kv, "scan:pids:spring26")).resolves.toBe(legacy);
  });

  it("throws an explicit key error before a value exceeds the safe size", () => {
    expect(() => assertKvValueSize("scan:data:huge", { payload: "x".repeat(100) }, 40)).toThrow(
      /scan:data:huge/
    );
  });

  it("deletes a sharded group using the marker shard count", async () => {
    const kv = createKv();
    await setShardedObjectByPid(
      kv,
      "scan:data:spring26",
      { productStats: { p1: { sold: 1 } } },
      { shardCount: 2, pidFields: ["productStats"] }
    );

    await delShardedObject(kv, "scan:data:spring26");

    expect(kv.values.has("scan:data:spring26")).toBe(false);
    expect(kv.values.has(shardedKvShardKey("scan:data:spring26", 0))).toBe(false);
    expect(kv.values.has(shardedKvShardKey("scan:data:spring26", 1))).toBe(false);
  });
});
