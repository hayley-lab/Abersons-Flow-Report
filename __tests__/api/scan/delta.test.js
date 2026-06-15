// Regression tests for the per-season delta handler (pages/api/scan/delta.js).
//
// Lives outside pages/ on purpose: anything under pages/ is compiled by Next as
// a route, so a test file there would deploy as a bogus serverless function.
//
// The production bug these guard against: the handler crashed in a way that
// escaped its try/catch (or timed out), so Vercel returned a generic HTML 500
// page instead of JSON. cron/delta then reported every season as
// `Unexpected token 'A' ... is not valid JSON`. The handler must ALWAYS respond
// with JSON — a clean error/skip when data is missing, and a projected result
// when the store-wide sales cache is complete — and it must NEVER page the
// store-wide inventory itself (that thundering herd caused the timeout).

jest.mock("@vercel/kv", () => {
  const store = new Map();
  return {
    kv: {
      _store: store,
      get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
      set: jest.fn(async (key, value) => {
        store.set(key, value);
      }),
      del: jest.fn(async (key) => {
        store.delete(key);
      }),
      hget: jest.fn(async () => null),
      hset: jest.fn(async () => undefined),
      hdel: jest.fn(async () => undefined),
    },
  };
});

jest.mock("../../../lib/ls-auth", () => ({
  getLsToken: jest.fn(async () => "test-token"),
  lsBase: jest.fn(() => "https://test.retail.lightspeed.app/api"),
  markLsAuthError: jest.fn(),
  markLsHealthy: jest.fn(),
}));

jest.mock("../../../lib/ls-fetch", () => ({
  makeLsFetch: jest.fn(() => {
    const fn = jest.fn(async () => ({ data: [] }));
    fn.callStats = { total: 0, byFamily: {} };
    return fn;
  }),
}));

jest.mock("../../../lib/sales-store", () => ({
  loadSalesStoreMeta: jest.fn(),
  loadSalesAgg: jest.fn(),
  // Real-shape projection: filter the aggregate to the season's pids.
  projectSeasonSales: (agg, seasonPids) => {
    const perPid = {};
    for (const pid of seasonPids || []) if (agg && agg[pid]) perPid[pid] = agg[pid];
    return perPid;
  },
}));

// inventory-ledger runs for real, but the handler must only READ the (empty)
// shared cache — it must never call syncInventoryCache. Spy to assert that.
jest.mock("../../../lib/inventory-ledger", () => {
  const actual = jest.requireActual("../../../lib/inventory-ledger");
  return {
    ...actual,
    syncInventoryCache: jest.fn((...args) => actual.syncInventoryCache(...args)),
  };
});

import { kv as mockKv } from "@vercel/kv";
import { loadSalesStoreMeta, loadSalesAgg } from "../../../lib/sales-store";
import { syncInventoryCache } from "../../../lib/inventory-ledger";
import { loadScanData } from "../../../lib/scan-data-store";
import handler from "../../../pages/api/scan/delta";

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  res.end = jest.fn(() => res);
  return res;
}

function makeReq(season = "fall26") {
  return {
    method: "POST",
    query: { season },
    headers: { authorization: "Bearer test-secret" },
  };
}

function seedScanData(season = "fall26") {
  mockKv._store.set(`scan:data:${season}`, {
    productStats: {
      p1: { qtyOrdered: 4, qtyReceived: 3, onHand: 3, liveOnHand: 3 },
    },
    seasonPids: ["p1"],
    pidToType: { p1: "dept1" },
    pidToSupplier: { p1: { i: "sup1", n: "Vendor One" } },
    pidToPrice: { p1: 100 },
    pidToCost: { p1: 40 },
    summaryRows: [{ id: "dept1", name: "Dept One" }],
  });
}

describe("scan/delta handler", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = "test-secret";
  });

  beforeEach(() => {
    mockKv._store.clear();
    mockKv.get.mockClear();
    mockKv.set.mockClear();
    // Restore default in-memory behavior in case a prior test overrode it.
    mockKv.get.mockImplementation(async (key) =>
      mockKv._store.has(key) ? mockKv._store.get(key) : null
    );
    mockKv.set.mockImplementation(async (key, value) => {
      mockKv._store.set(key, value);
    });
    loadSalesStoreMeta.mockReset();
    loadSalesAgg.mockReset();
    syncInventoryCache.mockClear();
  });

  it("returns JSON 409 (never throws / HTML) when no base scan data exists", async () => {
    const res = makeRes();
    await handler(makeReq(), res); // must resolve, never throw
    expect(res.statusCode).toBe(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "No base scan data found. Run a full scan first.",
    });
  });

  it("returns JSON 409 when the sales store is incomplete and no legacy ledger exists", async () => {
    seedScanData();
    loadSalesStoreMeta.mockResolvedValue(null); // store not built → legacy fallback
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "No sales ledger found. Run a full scan first." });
  });

  it("projects sales from the complete store aggregate and writes a delta result", async () => {
    seedScanData();
    loadSalesStoreMeta.mockResolvedValue({ complete: true, version: 42 });
    loadSalesAgg.mockResolvedValue({
      p1: { sold: 2, onSale: 1, saleAmt: 80, soldAmt: 200, returned: 0 },
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, ts: expect.any(Number) })
    );

    const stored = await loadScanData(mockKv, "fall26");
    expect(stored.isDelta).toBe(true);
    expect(stored.productStats.p1.sold).toBe(2);
    expect(stored.productStats.p1.onSale).toBe(1);
    expect(stored.productStats.p1.saleAmt).toBe(80);
    expect(stored.salesState.maxVersion).toBe(42);
  });

  it("never pages the store-wide inventory from the per-season delta (no timeout herd)", async () => {
    seedScanData();
    loadSalesStoreMeta.mockResolvedValue({ complete: true, version: 42 });
    loadSalesAgg.mockResolvedValue({});

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(syncInventoryCache).not.toHaveBeenCalled();
  });

  it("returns JSON 500 (not a throw) if a store read fails unexpectedly", async () => {
    seedScanData();
    loadSalesStoreMeta.mockResolvedValue({ complete: true, version: 42 });
    loadSalesAgg.mockRejectedValue(new Error("agg shard read blew up"));

    const res = makeRes();
    await handler(makeReq(), res); // must resolve to JSON, never throw
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "agg shard read blew up" });
  });

  it("returns JSON 500 (not a throw) if KV itself throws before the inner work", async () => {
    mockKv.get.mockRejectedValueOnce(new Error("kv unavailable"));
    const res = makeRes();
    await handler(makeReq(), res); // must resolve to JSON, never throw
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "kv unavailable" });
  });
});
