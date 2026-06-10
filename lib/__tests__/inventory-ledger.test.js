import { applyInventoryRows, liveOnHandFromCache, syncInventoryCache } from "../inventory-ledger";

const cacheKey = (season) => `scan:inv:${season}`;

function createKv() {
  const values = new Map();
  const calls = { set: [], del: [] };

  return {
    calls,
    values,
    async get(key) {
      return values.get(key) || null;
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

describe("inventory ledger", () => {
  it("stores per-outlet inventory and sums live on-hand by product", () => {
    const cache = applyInventoryRows({ version: null, byOutlet: {}, onHand: {} }, [
      { product_id: "p1", outlet_id: "o1", current_amount: 2 },
      { product_id: "p1", outlet_id: "o2", count: 3 },
      { product_id: "p2", outlet_id: "o1", quantity: 4 },
    ]);

    expect(liveOnHandFromCache(cache, "p1")).toBe(5);
    expect(liveOnHandFromCache(cache, "p2")).toBe(4);
    expect(liveOnHandFromCache(cache, "missing")).toBeNull();
  });

  it("full-syncs paginated inventory and stores the max version", async () => {
    const kv = createKv();
    const paths = [];
    const lsFetch = jest.fn(async (path) => {
      paths.push(path);
      if (paths.length === 1) {
        return {
          version: { max: 20 },
          data: [
            { product_id: "p1", outlet_id: "o1", current_amount: 2, version: 19 },
            { product_id: "p1", outlet_id: "o2", current_amount: 3, version: 20 },
          ],
        };
      }
      return {
        version: { max: 21 },
        data: [{ product_id: "p2", outlet_id: "o1", current_amount: 4, version: 21 }],
      };
    });

    const result = await syncInventoryCache(kv, "spring26", lsFetch, {
      reset: true,
      pageSize: 2,
    });

    expect(result.done).toBe(true);
    expect(result.version).toBe(21);
    expect(paths).toEqual([
      "2.0/inventory?size=2&sort_direction=asc",
      "2.0/inventory?size=2&sort_direction=asc&after=20",
    ]);
    expect(result.cache.onHand).toMatchObject({ p1: 5, p2: 4 });
    expect(kv.values.get(cacheKey("spring26"))).toBe(result.cache);
  });

  it("incrementally fetches only rows after the cached version", async () => {
    const kv = createKv();
    await kv.set(
      cacheKey("spring26"),
      { version: 30, byOutlet: { "p1:o1": 2 }, onHand: { p1: 2 } },
      { ex: 1 }
    );
    kv.calls.set = [];

    const lsFetch = jest.fn(async () => ({
      version: { max: 31 },
      data: [{ product_id: "p1", outlet_id: "o1", current_amount: 7, version: 31 }],
    }));

    const result = await syncInventoryCache(kv, "spring26", lsFetch, { pageSize: 500 });

    expect(lsFetch).toHaveBeenCalledWith("2.0/inventory?size=500&sort_direction=asc&after=30");
    expect(result.cache.version).toBe(31);
    expect(result.cache.onHand.p1).toBe(7);
    expect(kv.calls.set[0].options).toEqual({ ex: 180 * 24 * 3600 });
  });
});
