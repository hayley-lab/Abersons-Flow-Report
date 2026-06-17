import {
  CATALOG_META_KEY,
  DEFAULT_SHARD_COUNT,
  catalogShardKey,
  loadCatalogProducts,
  loadSeasonBucket,
  productMetaFromLs,
  seasonBucketKey,
  seasonBucketsFromCatalog,
  shardForPid,
  syncCatalogCache,
  writeSeasonBuckets,
} from "../catalog-store";

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

function product(id, sku, extra = {}) {
  return { id, sku, supplier: { id: "sup1", name: "Brand" }, price: 100, ...extra };
}

describe("shardForPid", () => {
  it("is deterministic for the same id", () => {
    expect(shardForPid("abc-123")).toBe(shardForPid("abc-123"));
    expect(shardForPid("abc-123", 8)).toBe(shardForPid("abc-123", 8));
  });

  it("stays within the shard range", () => {
    for (let i = 0; i < 200; i++) {
      const idx = shardForPid(`pid-${i}`, DEFAULT_SHARD_COUNT);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(DEFAULT_SHARD_COUNT);
    }
  });

  it("distributes ids across multiple shards", () => {
    const used = new Set();
    for (let i = 0; i < 500; i++) used.add(shardForPid(`product-${i}`, DEFAULT_SHARD_COUNT));
    expect(used.size).toBeGreaterThan(DEFAULT_SHARD_COUNT / 2);
  });
});

describe("productMetaFromLs", () => {
  it("extracts the pipeline fields with brand-primary vendor identity", () => {
    const meta = productMetaFromLs({
      id: "p1",
      sku: "brand/s2601",
      brand: { id: "brand9", name: "Staud" },
      supplier: { id: "sup9", name: "Shared Supplier" },
      product_type_id: "dept1",
      price: 250,
      supply_price: 120,
      active: true,
      is_active: true,
      has_inventory: true,
      handle: "brand-s2601",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      supplier_code: "VEND-123",
      variant_parent_id: "parent1",
      version: 42,
    });
    expect(meta).toMatchObject({
      sku: "brand/s2601",
      price: 250,
      cost: 120,
      active: true,
      hasInventory: true,
      deletedAt: null,
      handle: "brand-s2601",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      brandId: "brand9",
      brandName: "Staud",
      supplierCode: "VEND-123",
      variantParentId: "parent1",
      isVariant: true,
      suppId: "brand9",
      suppName: "Staud",
      typeId: "dept1",
      version: 42,
    });
  });

  it("falls back to supplier identity when brand is missing", () => {
    const meta = productMetaFromLs({
      id: "p2",
      sku: "supplier/s2601",
      supplier: { id: "sup9", name: "Supplier Vendor" },
    });
    expect(meta.suppId).toBe("sup9");
    expect(meta.suppName).toBe("Supplier Vendor");
  });

  it("falls back to __none__/Unknown when supplier is missing", () => {
    const meta = productMetaFromLs({ id: "p2", sku: "x/s2601" });
    expect(meta.suppId).toBe("__none__");
    expect(meta.suppName).toBe("Unknown");
    expect(meta.typeId).toBe("__none__");
    expect(meta.version).toBeNull();
    expect(meta.active).toBe(true);
    expect(meta.hasInventory).toBe(false);
    expect(meta.deletedAt).toBeNull();
    expect(meta.handle).toBe("");
    expect(meta.brandId).toBeNull();
    expect(meta.brandName).toBe("");
    expect(meta.supplierCode).toBe("");
    expect(meta.variantParentId).toBeNull();
    expect(meta.isVariant).toBe(false);
  });
});

describe("syncCatalogCache cold build", () => {
  it("pages the whole catalog via /search into shards and seeds meta.version", async () => {
    const kv = createKv();
    const paths = [];
    const lsFetch = jest.fn(async (path) => {
      paths.push(path);
      // Single short page -> done.
      return {
        data: [
          product("p1", "a/s2601", { version: 5 }),
          product("p2", "b/f2601", { version: 9 }),
          product("p3", "c/s2601", { version: 7 }),
        ],
      };
    });

    const result = await syncCatalogCache(kv, lsFetch, { reset: true });

    expect(result.complete).toBe(true);
    expect(result.done).toBe(true);
    expect(result.added).toBe(3);
    expect(result.version).toBe(9);
    expect(paths[0]).toContain("2.0/search?type=products");

    const meta = kv.values.get(CATALOG_META_KEY);
    expect(meta).toMatchObject({ version: 9, complete: true, buildOffset: 0 });

    const products = await loadCatalogProducts(kv, meta.shardCount);
    expect(Object.keys(products).sort()).toEqual(["p1", "p2", "p3"]);
    // Each product lands in its deterministic shard.
    const shardOfP1 = shardForPid("p1", meta.shardCount);
    expect(kv.values.get(catalogShardKey(shardOfP1))).toHaveProperty("p1");
  });

  it("probes the collection endpoint for a baseline when /search omits versions", async () => {
    const kv = createKv();
    const lsFetch = jest.fn(async (path) => {
      if (path.startsWith("2.0/search")) {
        return { data: [product("p1", "a/s2601"), product("p2", "b/s2601")] };
      }
      // probeMaxVersion
      return { version: { max: 1234 }, data: [] };
    });

    const result = await syncCatalogCache(kv, lsFetch, { reset: true });

    expect(result.complete).toBe(true);
    expect(result.version).toBe(1234);
    expect(lsFetch).toHaveBeenCalledWith("2.0/products?page_size=1&sort_direction=desc");
  });

  it("is resumable across calls via buildOffset and deadline", async () => {
    const kv = createKv();
    let now = 0;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);

    // A full page (length === SEARCH_PAGE_SIZE) forces searchPages to keep going,
    // but the clock advances so the page-budget margin trips and only one page is
    // processed per call. Each call checkpoints buildOffset durably.
    const fullPage = Array.from({ length: 1000 }, (_, i) => product(`p${i}`, `s${i}/s2601`));
    let call = 0;
    const lsFetch = jest.fn(async () => {
      call++;
      now += 41000; // each fetch eats most of the 60s budget
      return call === 1 ? { data: fullPage } : { data: [product("tail", "t/s2601")] };
    });

    const first = await syncCatalogCache(kv, lsFetch, { reset: true, deadline: 60000 });
    expect(first.complete).toBe(false);
    expect(first.added).toBe(1000);
    const meta1 = kv.values.get(CATALOG_META_KEY);
    expect(meta1.complete).toBe(false);
    // Durable cursor advanced to the next page start after the full page.
    expect(meta1.buildOffset).toBe(1000);

    // Resume: not reset, picks up at buildOffset and finishes on the short page.
    now = 100000;
    const second = await syncCatalogCache(kv, lsFetch, { deadline: 160000 });
    expect(second.complete).toBe(true);
    const meta2 = kv.values.get(CATALOG_META_KEY);
    expect(meta2.complete).toBe(true);
    expect(meta2.buildOffset).toBe(0);

    const products = await loadCatalogProducts(kv, meta2.shardCount);
    expect(products).toHaveProperty("tail");
    expect(Object.keys(products).length).toBe(1001);

    nowSpy.mockRestore();
  });

  it("checkpoints buildOffset durably when a page fetch fails mid-chunk", async () => {
    const kv = createKv();
    let now = 0;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);

    const fullPage = Array.from({ length: 1000 }, (_, i) => product(`p${i}`, `s${i}/s2601`));
    let call = 0;
    const lsFetch = jest.fn(async () => {
      call++;
      now += 5000;
      if (call === 1) return { data: fullPage };
      throw new Error("LS 503 /search: rate limited");
    });

    const result = await syncCatalogCache(kv, lsFetch, { reset: true, deadline: 60000 });

    // The first full page is persisted and the cursor advanced; the failed page
    // leaves the build incomplete so the next call resumes instead of restarting.
    expect(result.complete).toBe(false);
    expect(result.added).toBe(1000);
    const meta = kv.values.get(CATALOG_META_KEY);
    expect(meta.complete).toBe(false);
    expect(meta.buildOffset).toBe(1000);
    const products = await loadCatalogProducts(kv, meta.shardCount);
    expect(Object.keys(products).length).toBe(1000);

    nowSpy.mockRestore();
  });
});

describe("syncCatalogCache incremental", () => {
  it("upserts only changed products after the cached version and advances the cursor", async () => {
    const kv = createKv();
    // Seed a completed catalog.
    await kv.set(CATALOG_META_KEY, {
      version: 7,
      complete: true,
      buildOffset: 0,
      shardCount: DEFAULT_SHARD_COUNT,
    });
    const p1Shard = shardForPid("p1", DEFAULT_SHARD_COUNT);
    await kv.set(catalogShardKey(p1Shard), {
      p1: productMetaFromLs(product("p1", "a/s2601", { price: 100 })),
    });
    kv.calls.set = [];

    const paths = [];
    const lsFetch = jest.fn(async (path) => {
      paths.push(path);
      // One changed product, short page -> done.
      return {
        version: { max: 11 },
        data: [product("p1", "a/s2601", { price: 250, version: 11 })],
      };
    });

    const result = await syncCatalogCache(kv, lsFetch);

    expect(result.complete).toBe(true);
    expect(result.done).toBe(true);
    expect(result.version).toBe(11);
    expect(paths[0]).toContain("2.0/products?page_size=200&sort_direction=asc&after=7");

    const products = await loadCatalogProducts(kv, DEFAULT_SHARD_COUNT);
    expect(products.p1.price).toBe(250);
    const meta = kv.values.get(CATALOG_META_KEY);
    expect(meta.version).toBe(11);
  });

  it("stops without advancing when the cursor does not move", async () => {
    const kv = createKv();
    await kv.set(CATALOG_META_KEY, {
      version: 50,
      complete: true,
      buildOffset: 0,
      shardCount: DEFAULT_SHARD_COUNT,
    });

    const lsFetch = jest.fn(async () => ({ version: { max: 50 }, data: [] }));
    const result = await syncCatalogCache(kv, lsFetch);

    expect(result.done).toBe(true);
    expect(result.added).toBe(0);
    expect(lsFetch).toHaveBeenCalledTimes(1);
    expect(kv.values.get(CATALOG_META_KEY).version).toBe(50);
  });
});

describe("seasonBucketsFromCatalog", () => {
  const products = {
    p1: productMetaFromLs(product("p1", "alpha/s2601", { price: 100 })),
    p2: productMetaFromLs(product("p2", "beta/f2601", { price: 200 })),
    p3: productMetaFromLs(product("p3", "gamma/rs2601", { price: 300 })),
    p4: productMetaFromLs(product("p4", "no-season-code", { price: 400 })),
  };

  it("buckets each product into its matching season with the scan:pids shape", () => {
    const buckets = seasonBucketsFromCatalog(products, ["spring26", "fall26"]);

    expect(buckets.spring26.seasonPids.sort()).toEqual(["p1", "p3"]);
    expect(buckets.fall26.seasonPids).toEqual(["p2"]);
    expect(buckets.spring26.skuToPid["alpha/s2601"]).toBe("p1");
    expect(buckets.spring26.pidToPrice.p1).toBe(100);
    expect(buckets.spring26.pidToSupplier.p1).toEqual({ i: "sup1", n: "Brand" });
    expect(buckets.spring26.pidToSku.p3).toBe("gamma/rs2601");
    // Product with no season code is in no bucket.
    expect(buckets.spring26.seasonPids).not.toContain("p4");
    expect(buckets.fall26.seasonPids).not.toContain("p4");
  });

  it("places a multi-season SKU into every matching active season", () => {
    // 'rs26' matches both spring26 (combined transition season) and prespring26.
    const buckets = seasonBucketsFromCatalog(products, ["spring26", "prespring26"]);
    expect(buckets.spring26.seasonPids).toContain("p3");
    expect(buckets.prespring26.seasonPids).toContain("p3");
  });

  it("dedups pids per season", () => {
    const buckets = seasonBucketsFromCatalog(products, ["spring26"]);
    const pids = buckets.spring26.seasonPids;
    expect(new Set(pids).size).toBe(pids.length);
  });
});

describe("writeSeasonBuckets", () => {
  it("loads shards, buckets, and persists sharded per-season buckets with 180d TTL", async () => {
    const kv = createKv();
    await syncCatalogCache(
      kv,
      jest.fn(async () => ({
        data: [product("p1", "alpha/s2601"), product("p2", "beta/f2601")],
      })),
      { reset: true }
    );

    const buckets = await writeSeasonBuckets(kv, ["spring26", "fall26"]);

    expect(buckets.spring26.seasonPids).toEqual(["p1"]);
    await expect(loadSeasonBucket(kv, "spring26")).resolves.toEqual(buckets.spring26);
    await expect(loadSeasonBucket(kv, "fall26")).resolves.toEqual(buckets.fall26);
    expect(kv.values.get(seasonBucketKey("spring26"))).toMatchObject({
      sharded: true,
      scalar: { seasonPids: ["p1"] },
    });
    const setCall = kv.calls.set.find((c) => c.key === seasonBucketKey("spring26"));
    expect(setCall.options).toEqual({ ex: 180 * 24 * 3600 });
  });

  it("loads legacy per-season buckets unchanged", async () => {
    const kv = createKv();
    const legacy = {
      seasonPids: ["p1"],
      skuToPid: { "alpha/s2601": "p1" },
      pidToPrice: { p1: 100 },
    };
    await kv.set(seasonBucketKey("spring26"), legacy, { ex: 1 });

    await expect(loadSeasonBucket(kv, "spring26")).resolves.toBe(legacy);
  });
});
