import {
  backfillSales,
  clearLedger,
  loadSalesState,
  rebuildSalesState,
  reconcileSale,
  saveSalesState,
} from "../sales-ledger";

const ledgerKey = (season) => `scan:sales:ledger:${season}`;
const stateKey = (season) => `scan:sales:state:${season}`;

function createKv() {
  const values = new Map();
  const hashes = new Map();
  const calls = { set: [], del: [], hset: [], hdel: [] };

  return {
    calls,
    values,
    hashes,
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
      hashes.delete(key);
    },
    async hget(key, field) {
      return (hashes.get(key) || {})[field] || null;
    },
    async hset(key, entries) {
      calls.hset.push({ key, entries });
      hashes.set(key, { ...(hashes.get(key) || {}), ...entries });
    },
    async hdel(key, field) {
      calls.hdel.push({ key, field });
      const hash = { ...(hashes.get(key) || {}) };
      delete hash[field];
      hashes.set(key, hash);
    },
    async hgetall(key) {
      return hashes.get(key) || {};
    },
  };
}

describe("sales ledger state persistence", () => {
  it("loads a default state and saves pid sets with a TTL", async () => {
    const kv = createKv();

    await expect(loadSalesState(kv, "spring26")).resolves.toEqual({
      maxVersion: null,
      perPid: {},
      pidSet: [],
    });

    const saved = await saveSalesState(
      kv,
      "spring26",
      { maxVersion: 10, perPid: { p1: { sold: 1 } } },
      new Set(["p1", "p2"])
    );

    expect(saved).toMatchObject({
      maxVersion: 10,
      perPid: { p1: { sold: 1 } },
      pidSet: ["p1", "p2"],
    });
    expect(kv.values.get(stateKey("spring26"))).toBe(saved);
    expect(kv.calls.set[0].options).toEqual({ ex: 180 * 24 * 3600 });
  });

  it("clears the season ledger hash", async () => {
    const kv = createKv();
    await kv.hset(ledgerKey("spring26"), { sale1: { saleId: "sale1", perPid: {} } });

    await clearLedger(kv, "spring26");

    expect(await kv.hgetall(ledgerKey("spring26"))).toEqual({});
    expect(kv.calls.del).toEqual([ledgerKey("spring26")]);
  });
});

describe("backfillSales", () => {
  it("builds ledger entries in one batch and skips voided or empty sales", async () => {
    const kv = createKv();
    const state = { maxVersion: null, perPid: {}, pidSet: [] };
    const seasonPidSet = new Set(["p1"]);

    await backfillSales(
      kv,
      "spring26",
      state,
      [
        {
          id: "sale-1",
          version: 10,
          status: "CLOSED",
          line_items: [{ product_id: "p1", quantity: 2, total_price: "200" }],
        },
        {
          id: "voided",
          version: 11,
          status: "VOIDED",
          line_items: [{ product_id: "p1", quantity: 1, total_price: "100" }],
        },
        {
          id: "not-season",
          version: 12,
          status: "CLOSED",
          line_items: [{ product_id: "p2", quantity: 1, total_price: "100" }],
        },
      ],
      seasonPidSet,
      { p1: 100 }
    );

    expect(state.maxVersion).toBe(12);
    expect(state.perPid.p1).toEqual({
      sold: 2,
      onSale: 0,
      saleAmt: 0,
      soldAmt: 200,
      returned: 0,
    });
    expect(kv.calls.hset).toHaveLength(1);
    expect(Object.keys(kv.calls.hset[0].entries)).toEqual(["sale-1"]);
    expect(await kv.hget(ledgerKey("spring26"), "sale-1")).toMatchObject({
      saleId: "sale-1",
      version: 10,
      perPid: { p1: expect.objectContaining({ sold: 2 }) },
    });
  });
});

describe("reconcileSale", () => {
  it("does nothing when the existing ledger entry has the same version", async () => {
    const kv = createKv();
    const oldEntry = {
      saleId: "sale-1",
      version: 5,
      perPid: { p1: { sold: 1, onSale: 0, saleAmt: 0, soldAmt: 100, returned: 0 } },
    };
    await kv.hset(ledgerKey("spring26"), { "sale-1": oldEntry });
    kv.calls.hset = [];
    const state = { maxVersion: 5, perPid: { p1: { ...oldEntry.perPid.p1 } }, pidSet: [] };

    await expect(
      reconcileSale(
        kv,
        "spring26",
        state,
        {
          id: "sale-1",
          version: 5,
          status: "CLOSED",
          line_items: [{ product_id: "p1", quantity: 1, total_price: "100" }],
        },
        new Set(["p1"]),
        { p1: 100 }
      )
    ).resolves.toEqual({ changed: false, version: 5 });

    expect(kv.calls.hset).toEqual([]);
    expect(kv.calls.hdel).toEqual([]);
    expect(state.perPid.p1).toEqual(oldEntry.perPid.p1);
  });

  it("reverses the previous contribution and writes changed sale totals", async () => {
    const kv = createKv();
    const oldEntry = {
      saleId: "sale-1",
      version: 5,
      perPid: { p1: { sold: 1, onSale: 0, saleAmt: 0, soldAmt: 100, returned: 0 } },
    };
    await kv.hset(ledgerKey("spring26"), { "sale-1": oldEntry });
    const state = { maxVersion: 5, perPid: { p1: { ...oldEntry.perPid.p1 } }, pidSet: [] };

    await expect(
      reconcileSale(
        kv,
        "spring26",
        state,
        {
          id: "sale-1",
          version: 6,
          status: "CLOSED",
          line_items: [{ product_id: "p1", quantity: 1, total_price: "50", discount: "50" }],
        },
        new Set(["p1"]),
        { p1: 100 }
      )
    ).resolves.toEqual({ changed: true, version: 6 });

    expect(state.maxVersion).toBe(6);
    expect(state.perPid.p1).toEqual({
      sold: 0,
      onSale: 1,
      saleAmt: 50,
      soldAmt: 50,
      returned: 0,
    });
    expect(await kv.hget(ledgerKey("spring26"), "sale-1")).toMatchObject({
      saleId: "sale-1",
      version: 6,
      perPid: { p1: expect.objectContaining({ onSale: 1, saleAmt: 50 }) },
    });
  });

  it("removes and reverses old entries for voided or empty sale updates", async () => {
    const kv = createKv();
    const oldEntry = {
      saleId: "sale-1",
      version: 5,
      perPid: { p1: { sold: 1, onSale: 0, saleAmt: 0, soldAmt: 100, returned: 0 } },
    };
    await kv.hset(ledgerKey("spring26"), { "sale-1": oldEntry });
    const state = { maxVersion: 5, perPid: { p1: { ...oldEntry.perPid.p1 } }, pidSet: [] };

    await expect(
      reconcileSale(
        kv,
        "spring26",
        state,
        { id: "sale-1", version: 6, status: "VOIDED", line_items: [] },
        new Set(["p1"]),
        { p1: 100 }
      )
    ).resolves.toEqual({ changed: true, version: 6 });

    expect(state.perPid.p1).toEqual({
      sold: 0,
      onSale: 0,
      saleAmt: 0,
      soldAmt: 0,
      returned: 0,
    });
    expect(await kv.hget(ledgerKey("spring26"), "sale-1")).toBeNull();

    await kv.hset(ledgerKey("spring26"), { "sale-2": oldEntry });
    state.perPid.p1 = { ...oldEntry.perPid.p1 };

    await expect(
      reconcileSale(
        kv,
        "spring26",
        state,
        {
          id: "sale-2",
          version: 7,
          status: "CLOSED",
          line_items: [{ product_id: "p2", quantity: 1, total_price: "100" }],
        },
        new Set(["p1"]),
        { p1: 100 }
      )
    ).resolves.toEqual({ changed: true, version: 7 });

    expect(await kv.hget(ledgerKey("spring26"), "sale-2")).toBeNull();
    expect(state.perPid.p1).toEqual({
      sold: 0,
      onSale: 0,
      saleAmt: 0,
      soldAmt: 0,
      returned: 0,
    });
  });
});

describe("rebuildSalesState", () => {
  it("rebuilds per-product totals and maxVersion from ledger entries", async () => {
    const kv = createKv();
    await kv.hset(ledgerKey("spring26"), {
      "sale-1": JSON.stringify({
        saleId: "sale-1",
        version: 3,
        perPid: { p1: { sold: 1, onSale: 0, saleAmt: 0, soldAmt: 100, returned: 0 } },
      }),
      "sale-2": {
        saleId: "sale-2",
        version: 8,
        perPid: { p1: { sold: 0, onSale: 1, saleAmt: 50, soldAmt: 50, returned: 0 } },
      },
      malformed: "{",
    });

    const rebuilt = await rebuildSalesState(kv, "spring26");

    expect(rebuilt.maxVersion).toBe(8);
    expect(rebuilt.perPid.p1).toEqual({
      sold: 1,
      onSale: 1,
      saleAmt: 50,
      soldAmt: 150,
      returned: 0,
    });
    expect(kv.values.get(stateKey("spring26"))).toMatchObject({
      maxVersion: 8,
      perPid: rebuilt.perPid,
      pidSet: [],
    });
  });
});
