import {
  assertKvValueSize,
  delShardedObject,
  getShardedObjectByPid,
  jsonSizeBytes,
  setShardedObjectByPid,
  setShardedObjectByPidShards,
  shardedKvShardKey,
  shardForPid,
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

  it("writes only touched shards + marker, leaving untouched shards intact", async () => {
    const kv = createKv();
    const shardCount = 4;
    const baseKey = "scan:inv:store";
    // Pick two pids that land on DIFFERENT shards so we can prove the untouched
    // shard is never rewritten.
    let pidA = null;
    let pidB = null;
    for (let i = 0; i < 1000 && (!pidA || !pidB); i++) {
      const pid = `p${i}`;
      const shard = shardForPid(pid, shardCount);
      if (pidA == null) pidA = pid;
      else if (shardForPid(pidA, shardCount) !== shard) pidB = pid;
    }
    expect(shardForPid(pidA, shardCount)).not.toBe(shardForPid(pidB, shardCount));

    // Full baseline write of both pids.
    const baseline = {
      ts: 1,
      version: 10,
      onHand: { [pidA]: 2, [pidB]: 9 },
      byOutletByPid: { [pidA]: { o1: 2 }, [pidB]: { o1: 9 } },
    };
    await setShardedObjectByPid(kv, baseKey, baseline, {
      ex: 60,
      shardCount,
      pidFields: ["onHand", "byOutletByPid"],
    });

    const shardA = shardedKvShardKey(baseKey, shardForPid(pidA, shardCount));
    const shardB = shardedKvShardKey(baseKey, shardForPid(pidB, shardCount));
    const untouchedShardBValue = kv.values.get(shardB);

    // Now change only pidA and checkpoint with touchedPids = {pidA}.
    kv.calls.set = [];
    const updated = {
      ts: 2,
      version: 11,
      onHand: { [pidA]: 5, [pidB]: 9 },
      byOutletByPid: { [pidA]: { o1: 5 }, [pidB]: { o1: 9 } },
    };
    await setShardedObjectByPidShards(kv, baseKey, updated, {
      ex: 60,
      shardCount,
      pidFields: ["onHand", "byOutletByPid"],
      touchedPids: new Set([pidA]),
    });

    const writtenKeys = kv.calls.set.map((c) => c.key);
    expect(writtenKeys).toContain(baseKey); // marker always written
    expect(writtenKeys).toContain(shardA); // touched shard written
    expect(writtenKeys).not.toContain(shardB); // untouched shard left intact
    // The untouched shard value is byte-for-byte the prior baseline write.
    expect(kv.values.get(shardB)).toBe(untouchedShardBValue);

    // A full read reconstructs the change AND the untouched pid correctly.
    const result = await getShardedObjectByPid(kv, baseKey);
    expect(result.version).toBe(11);
    expect(result.onHand).toEqual({ [pidA]: 5, [pidB]: 9 });
    expect(result.byOutletByPid).toEqual({ [pidA]: { o1: 5 }, [pidB]: { o1: 9 } });
  });

  it("writes only the marker when the touched set is empty", async () => {
    const kv = createKv();
    await setShardedObjectByPidShards(
      kv,
      "scan:inv:store",
      { version: 7, onHand: { p1: 1 }, byOutletByPid: { p1: { o1: 1 } } },
      { ex: 60, shardCount: 4, pidFields: ["onHand", "byOutletByPid"], touchedPids: new Set() }
    );

    const writtenKeys = kv.calls.set.map((c) => c.key);
    expect(writtenKeys).toEqual(["scan:inv:store"]);
    expect(kv.values.get("scan:inv:store")).toMatchObject({
      sharded: true,
      scalar: { version: 7 },
    });
  });

  it("writes every shard when touchedPids is omitted (full coverage)", async () => {
    const kv = createKv();
    await setShardedObjectByPidShards(
      kv,
      "scan:inv:store",
      { version: 7, onHand: { p1: 1, p2: 2 }, byOutletByPid: { p1: { o1: 1 }, p2: { o1: 2 } } },
      { ex: 60, shardCount: 4, pidFields: ["onHand", "byOutletByPid"] }
    );

    const shardKeys = kv.calls.set.map((c) => c.key).filter((k) => k.includes(":shard:"));
    expect(shardKeys).toHaveLength(4);
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
