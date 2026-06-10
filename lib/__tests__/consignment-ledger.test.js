import {
  applyConsignmentTotalsToMaps,
  buildConsignmentEntry,
  clearConsignmentLedger,
  loadConsignmentState,
  reconcileConsignment,
  saveConsignmentState,
} from "../consignment-ledger";

const ledgerKey = (season) => `scan:consign:ledger:${season}`;
const stateKey = (season) => `scan:consign:state:${season}`;

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

describe("consignment ledger state", () => {
  it("loads defaults, saves pid sets, and clears ledger keys", async () => {
    const kv = createKv();

    await expect(loadConsignmentState(kv, "spring26")).resolves.toEqual({
      maxVersionByType: {},
      perPid: {},
      pidSet: [],
      salesFloorDate: null,
      ts: null,
    });

    const saved = await saveConsignmentState(
      kv,
      "spring26",
      {
        maxVersionByType: { SUPPLIER: 10 },
        perPid: { p1: { qtyOrdered: 2, qtyReceived: 1, qtyReturned: 0 } },
      },
      new Set(["p1"])
    );

    expect(saved).toMatchObject({
      maxVersionByType: { SUPPLIER: 10 },
      pidSet: ["p1"],
    });
    expect(kv.values.get(stateKey("spring26"))).toBe(saved);

    await kv.hset(ledgerKey("spring26"), { c1: { perPid: {} } });
    await clearConsignmentLedger(kv, "spring26");
    expect(await kv.hgetall(ledgerKey("spring26"))).toEqual({});
    expect(kv.calls.del).toEqual([ledgerKey("spring26"), stateKey("spring26")]);
  });
});

describe("buildConsignmentEntry", () => {
  it("lazy-registers season products and builds supplier quantities", async () => {
    const seasonPidSet = new Set(["p1"]);
    const ensureSeasonProduct = jest.fn(async (pid) => pid === "p2");

    const entry = await buildConsignmentEntry(
      { id: "po-1", version: 5, created_at: "2026-01-02T00:00:00Z" },
      [
        { product_id: "p1", count: 2, received: 1 },
        { product_id: "p2", count: 3, received: 0 },
        { product_id: "p3", count: 4, received: 4 },
      ],
      "SUPPLIER",
      seasonPidSet,
      ensureSeasonProduct
    );

    expect(ensureSeasonProduct).toHaveBeenCalledWith("p2");
    expect(ensureSeasonProduct).toHaveBeenCalledWith("p3");
    expect(seasonPidSet.has("p2")).toBe(true);
    expect(entry).toMatchObject({
      consignmentId: "po-1",
      type: "SUPPLIER",
      version: 5,
      date: "2026-01-02",
      perPid: {
        p1: { qtyOrdered: 2, qtyReceived: 1, qtyReturned: 0 },
        p2: { qtyOrdered: 3, qtyReceived: 0, qtyReturned: 0 },
      },
    });
  });

  it("records vendor-return quantity only in qtyReturned", async () => {
    const entry = await buildConsignmentEntry(
      { id: "ret-1", version: 7 },
      [{ product_id: "p1", count: -2, received: 0 }],
      "RETURN",
      new Set(["p1"]),
      jest.fn()
    );

    expect(entry.perPid.p1).toEqual({ qtyOrdered: 0, qtyReceived: 0, qtyReturned: 2 });
  });
});

describe("reconcileConsignment", () => {
  it("writes new entries and updates per-product totals", async () => {
    const kv = createKv();
    const state = { maxVersionByType: {}, perPid: {}, pidSet: [] };

    await reconcileConsignment(
      kv,
      "spring26",
      state,
      { id: "po-1", version: 10, created_at: "2026-01-03T00:00:00Z" },
      [{ product_id: "p1", count: 2, received: 1 }],
      "SUPPLIER",
      new Set(["p1"]),
      jest.fn()
    );

    expect(state.maxVersionByType.SUPPLIER).toBe(10);
    expect(state.salesFloorDate).toBe("2026-01-03");
    expect(state.perPid.p1).toEqual({ qtyOrdered: 2, qtyReceived: 1, qtyReturned: 0 });
    expect(await kv.hget(ledgerKey("spring26"), "po-1")).toMatchObject({
      consignmentId: "po-1",
      version: 10,
    });
  });

  it("subtracts the old contribution before adding a changed PO", async () => {
    const kv = createKv();
    const oldEntry = {
      consignmentId: "po-1",
      type: "SUPPLIER",
      version: 5,
      perPid: { p1: { qtyOrdered: 1, qtyReceived: 1, qtyReturned: 0 } },
    };
    await kv.hset(ledgerKey("spring26"), { "po-1": oldEntry });
    const state = {
      maxVersionByType: { SUPPLIER: 5 },
      perPid: { p1: { ...oldEntry.perPid.p1 } },
      pidSet: [],
    };

    await reconcileConsignment(
      kv,
      "spring26",
      state,
      { id: "po-1", version: 6 },
      [{ product_id: "p1", count: 3, received: 2 }],
      "SUPPLIER",
      new Set(["p1"]),
      jest.fn()
    );

    expect(state.perPid.p1).toEqual({ qtyOrdered: 3, qtyReceived: 2, qtyReturned: 0 });
    expect(state.maxVersionByType.SUPPLIER).toBe(6);
  });

  it("removes and reverses a voided return consignment", async () => {
    const kv = createKv();
    const oldEntry = {
      consignmentId: "ret-1",
      type: "RETURN",
      version: 5,
      perPid: { p1: { qtyOrdered: 0, qtyReceived: 0, qtyReturned: 2 } },
    };
    await kv.hset(ledgerKey("spring26"), { "ret-1": oldEntry });
    const state = {
      maxVersionByType: { RETURN: 5 },
      perPid: { p1: { ...oldEntry.perPid.p1 } },
      pidSet: [],
    };

    await reconcileConsignment(
      kv,
      "spring26",
      state,
      { id: "ret-1", version: 6, status: "VOIDED" },
      [],
      "RETURN",
      new Set(["p1"]),
      jest.fn()
    );

    expect(state.perPid).toEqual({});
    expect(await kv.hget(ledgerKey("spring26"), "ret-1")).toBeNull();
    expect(kv.calls.hdel).toEqual([{ key: ledgerKey("spring26"), field: "ret-1" }]);
  });
});

describe("applyConsignmentTotalsToMaps", () => {
  it("hydrates scan quantity maps from ledger totals", () => {
    const state = {};

    applyConsignmentTotalsToMaps(state, {
      salesFloorDate: "2026-01-01",
      perPid: {
        p1: { qtyOrdered: 2, qtyReceived: 1, qtyReturned: 0 },
        p2: { qtyOrdered: 0, qtyReceived: 0, qtyReturned: 3 },
      },
    });

    expect(state.pidToQtyOrdered).toEqual({ p1: 2 });
    expect(state.pidToQtyReceived).toEqual({ p1: 1 });
    expect(state.pidToQtyReturned).toEqual({ p2: 3 });
    expect(state.salesFloorDate).toBe("2026-01-01");
  });
});
