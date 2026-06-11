import {
  SALES_STORE_LEDGER_KEY,
  SALES_STORE_META_KEY,
  clearSalesStore,
  loadSalesAgg,
  projectSeasonSales,
  salesAggShardKey,
  syncSalesStore,
} from "../sales-store";
import { DEFAULT_SHARD_COUNT, shardForPid } from "../catalog-store";

// KV mock with hash support (hget/hset/hdel) for the per-sale ledger.
function createKv() {
  const values = new Map();
  const hashes = new Map();
  const calls = { set: [], del: [] };
  function hash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  }
  return {
    values,
    hashes,
    calls,
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
      hashes.delete(key);
    },
    async hget(key, field) {
      const v = hash(key).get(String(field));
      return v ?? null;
    },
    async hset(key, obj) {
      const h = hash(key);
      for (const [f, v] of Object.entries(obj)) h.set(String(f), v);
    },
    async hdel(key, field) {
      hash(key).delete(String(field));
    },
  };
}

// A full-price sale of one season pid.
function sale(id, version, lineItems, extra = {}) {
  return { id, version, status: "CLOSED", line_items: lineItems, ...extra };
}

function li(productId, quantity, totalPrice, extra = {}) {
  return { product_id: productId, quantity, total_price: totalPrice, ...extra };
}

// A backfill needs one trailing empty page to terminate on the version cursor;
// returning the same page forever would double-count. This serves the data page
// once, then drains.
function onceThenEmpty(data, versionMax) {
  let call = 0;
  return jest.fn(async () => {
    call++;
    return call === 1 ? { version: { max: versionMax }, data } : { data: [] };
  });
}

describe("syncSalesStore cold build", () => {
  it("pages all sales into the ledger + aggregate and records the version", async () => {
    const kv = createKv();
    let call = 0;
    const lsFetch = jest.fn(async () => {
      call++;
      if (call === 1) {
        return {
          version: { max: 20 },
          data: [
            sale("s1", 10, [li("p1", 1, 100)]),
            sale("s2", 20, [li("p2", 2, 300, { discount: 50 })]),
          ],
        };
      }
      return { data: [] }; // drained
    });

    const result = await syncSalesStore(kv, lsFetch, { reset: true, dateFrom: "2025-01-01" });

    expect(result.complete).toBe(true);
    expect(result.version).toBe(20);

    const meta = kv.values.get(SALES_STORE_META_KEY);
    expect(meta).toMatchObject({ version: 20, complete: true });

    const agg = await loadSalesAgg(kv);
    // p1 sold full price (1 unit, $100), p2 discounted (on sale, 2 units, $300).
    expect(agg.p1).toMatchObject({ sold: 1, onSale: 0, soldAmt: 100 });
    expect(agg.p2).toMatchObject({ sold: 0, onSale: 2, saleAmt: 300 });

    // Ledger holds a per-sale entry for incremental reconcile.
    expect(kv.hashes.get(SALES_STORE_LEDGER_KEY).has("s1")).toBe(true);
    expect(kv.hashes.get(SALES_STORE_LEDGER_KEY).has("s2")).toBe(true);
    // Aggregate is sharded by pid.
    const p1Shard = shardForPid("p1", DEFAULT_SHARD_COUNT);
    expect(kv.values.get(salesAggShardKey(p1Shard))).toHaveProperty("p1");
  });

  it("paginates via the version cursor (date_from on the backfill)", async () => {
    const kv = createKv();
    const paths = [];
    let call = 0;
    const lsFetch = jest.fn(async (path) => {
      paths.push(path);
      call++;
      if (call === 1) return { version: { max: 5 }, data: [sale("s1", 5, [li("p1", 1, 100)])] };
      return { data: [] }; // drained
    });

    await syncSalesStore(kv, lsFetch, { reset: true, dateFrom: "2025-02-01" });

    expect(paths[0]).toContain("date_from=2025-02-01");
    expect(paths[1]).toContain("after=5");
  });
});

describe("syncSalesStore incremental", () => {
  it("reconciles a changed sale: subtracts the old contribution and adds the new", async () => {
    const kv = createKv();
    // Cold build: p1 sold 1 @ $100.
    await syncSalesStore(kv, onceThenEmpty([sale("s1", 5, [li("p1", 1, 100)])], 5), {
      reset: true,
      dateFrom: "2025-01-01",
    });

    let agg = await loadSalesAgg(kv);
    expect(agg.p1.sold).toBe(1);

    // Incremental: s1 edited to 3 units @ $300 (version bumped).
    const inc = jest.fn(async (path) => {
      if (path.includes("after=5")) {
        return { version: { max: 9 }, data: [sale("s1", 9, [li("p1", 3, 300)])] };
      }
      return { data: [] };
    });
    const result = await syncSalesStore(kv, inc, { dateFrom: "" });

    expect(result.complete).toBe(true);
    agg = await loadSalesAgg(kv);
    // Old (1 unit) subtracted, new (3 units) added -> net 3, not 4.
    expect(agg.p1.sold).toBe(3);
    expect(agg.p1.soldAmt).toBe(300);
  });

  it("removes a voided sale from the aggregate", async () => {
    const kv = createKv();
    await syncSalesStore(kv, onceThenEmpty([sale("s1", 5, [li("p1", 2, 200)])], 5), {
      reset: true,
      dateFrom: "2025-01-01",
    });
    expect((await loadSalesAgg(kv)).p1.sold).toBe(2);

    const inc = jest.fn(async (path) => {
      if (path.includes("after=5")) {
        return { version: { max: 8 }, data: [sale("s1", 8, [li("p1", 2, 200)], { status: "VOIDED" })] };
      }
      return { data: [] };
    });
    await syncSalesStore(kv, inc, { dateFrom: "" });

    const agg = await loadSalesAgg(kv);
    expect(agg.p1.sold).toBe(0);
    expect(kv.hashes.get(SALES_STORE_LEDGER_KEY).has("s1")).toBe(false);
  });

  it("skips a sale whose version is unchanged (idempotent)", async () => {
    const kv = createKv();
    await syncSalesStore(kv, onceThenEmpty([sale("s1", 5, [li("p1", 1, 100)])], 5), {
      reset: true,
      dateFrom: "2025-01-01",
    });

    const inc = jest.fn(async (path) => {
      if (path.includes("after=5")) {
        return { version: { max: 5 }, data: [sale("s1", 5, [li("p1", 1, 100)])] };
      }
      return { data: [] };
    });
    await syncSalesStore(kv, inc, { dateFrom: "" });

    expect((await loadSalesAgg(kv)).p1.sold).toBe(1);
  });
});

describe("projectSeasonSales", () => {
  it("filters the store aggregate down to one season's pids", () => {
    const agg = {
      p1: { sold: 1, onSale: 0, saleAmt: 0, soldAmt: 100, returned: 0 },
      p2: { sold: 0, onSale: 2, saleAmt: 300, soldAmt: 300, returned: 0 },
      p3: { sold: 5, onSale: 0, saleAmt: 0, soldAmt: 500, returned: 0 },
    };
    const perPid = projectSeasonSales(agg, ["p1", "p3", "missing"]);
    expect(Object.keys(perPid).sort()).toEqual(["p1", "p3"]);
    expect(perPid.p1.sold).toBe(1);
    expect(perPid.p3.sold).toBe(5);
  });

  it("returns an empty object when no pids match", () => {
    expect(projectSeasonSales({ p1: { sold: 1 } }, ["x", "y"])).toEqual({});
    expect(projectSeasonSales(null, ["p1"])).toEqual({});
  });
});

describe("clearSalesStore", () => {
  it("deletes meta, ledger, and every aggregate shard", async () => {
    const kv = createKv();
    await syncSalesStore(kv, onceThenEmpty([sale("s1", 5, [li("p1", 1, 100)])], 5), {
      reset: true,
      dateFrom: "2025-01-01",
    });
    await clearSalesStore(kv);
    expect(kv.values.get(SALES_STORE_META_KEY)).toBeUndefined();
    expect(kv.hashes.get(SALES_STORE_LEDGER_KEY)).toBeUndefined();
    expect(await loadSalesAgg(kv)).toEqual({});
  });
});
