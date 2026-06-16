import { createRollupCache } from "../rollup-cache";

describe("rollup cache", () => {
  function makeCache(options = {}) {
    let currentTime = 1_000;
    const cache = createRollupCache({
      ttlMs: 100,
      maxEntries: 2,
      now: () => currentTime,
      ...options,
    });

    return {
      cache,
      advance(ms) {
        currentTime += ms;
      },
    };
  }

  it("returns undefined for misses and the cached value for hits", () => {
    const { cache } = makeCache();
    const rolled = { rows: [{ id: "p1" }], summaryRows: [], deptVendors: {} };

    expect(cache.get("spring26:1:none")).toBeUndefined();
    cache.set("spring26:1:none", rolled);

    expect(cache.get("spring26:1:none")).toBe(rolled);
  });

  it("expires entries after the configured ttl", () => {
    const { cache, advance } = makeCache({ ttlMs: 50 });
    const rolled = { rows: [], summaryRows: [], deptVendors: {} };

    cache.set("spring26:1:none", rolled);
    advance(49);
    expect(cache.get("spring26:1:none")).toBe(rolled);

    advance(2);
    expect(cache.get("spring26:1:none")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("treats changed scan timestamps or override signatures as different keys", () => {
    const { cache } = makeCache();
    const rolled = { rows: [], summaryRows: [], deptVendors: {} };

    cache.set("spring26:1:2:10", rolled);

    expect(cache.get("spring26:2:2:10")).toBeUndefined();
    expect(cache.get("spring26:1:3:14")).toBeUndefined();
    expect(cache.get("spring26:1:2:10")).toBe(rolled);
  });

  it("evicts the least-recently-used entry when the cache is full", () => {
    const { cache } = makeCache({ maxEntries: 2 });
    const first = { rows: ["first"] };
    const second = { rows: ["second"] };
    const third = { rows: ["third"] };

    cache.set("first", first);
    cache.set("second", second);
    expect(cache.get("first")).toBe(first);

    cache.set("third", third);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(first);
    expect(cache.get("third")).toBe(third);
  });
});
