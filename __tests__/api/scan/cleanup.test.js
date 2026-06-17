let sessionAuthed = false;
let catalogMeta = { complete: true, shardCount: 16 };
let inventoryMeta = { complete: true };
let salesMeta = { complete: true, shardCount: 16 };
let catalogProducts = {};
let inventoryCache = { onHand: {} };
let salesAgg = {};

jest.mock("iron-session", () => ({
  getIronSession: jest.fn(async () => ({ authed: sessionAuthed })),
}));
jest.mock("../../../lib/session", () => ({ sessionOptions: {} }));

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
    },
  };
});

jest.mock("../../../lib/catalog-store", () => ({
  DEFAULT_SHARD_COUNT: 16,
  loadCatalogMeta: jest.fn(async () => catalogMeta),
  loadCatalogProducts: jest.fn(async () => catalogProducts),
}));
jest.mock("../../../lib/inventory-ledger", () => ({
  loadInventoryMeta: jest.fn(async () => inventoryMeta),
  loadInventoryCache: jest.fn(async () => inventoryCache),
}));
jest.mock("../../../lib/sales-store", () => ({
  loadSalesStoreMeta: jest.fn(async () => salesMeta),
  loadSalesAgg: jest.fn(async () => salesAgg),
}));
jest.mock("../../../lib/ls-auth", () => ({
  getLsToken: jest.fn(async () => "test-token"),
  lsBase: jest.fn(() => "https://test.retail.lightspeed.app/api"),
  markLsAuthError: jest.fn(),
  markLsHealthy: jest.fn(),
  setLsHealth: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/ls-fetch", () => ({
  parseRetryAfterMs: jest.fn(() => null),
  makeLsFetch: jest.fn(() => {
    const fn = jest.fn(async () => ({ data: [] }));
    fn.callStats = { total: 0, byFamily: {} };
    return fn;
  }),
}));

import { kv as mockKv } from "@vercel/kv";
import { setLsHealth } from "../../../lib/ls-auth";
import handler from "../../../pages/api/scan/cleanup";

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

function makeReq({ method = "POST", auth = false } = {}) {
  return {
    method,
    query: {},
    headers: auth ? { authorization: "Bearer test-secret" } : {},
  };
}

function activeProduct(extra = {}) {
  return {
    sku: "stale/s2601",
    active: true,
    hasInventory: true,
    deletedAt: null,
    ...extra,
  };
}

describe("scan/cleanup handler", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = "test-secret";
  });

  beforeEach(() => {
    sessionAuthed = false;
    catalogMeta = { complete: true, shardCount: 16 };
    inventoryMeta = { complete: true };
    salesMeta = { complete: true, shardCount: 16 };
    catalogProducts = {};
    inventoryCache = { onHand: {} };
    salesAgg = {};
    mockKv._store.clear();
    mockKv.set.mockClear();
    setLsHealth.mockClear();
    delete process.env.CLEANUP_ENABLED;
    delete process.env.CLEANUP_MAX_WRITES;
    delete process.env.CLEANUP_ANOMALY_MAX;
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: jest.fn(() => null) },
      text: async () => "{}",
    }));
  });

  afterEach(() => {
    delete global.fetch;
  });

  it("401s without cron bearer or session auth", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(401);
  });

  it("aborts without writing when a required cache is incomplete", async () => {
    catalogMeta = { complete: false };

    const res = makeRes();
    await handler(makeReq({ auth: true }), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain("Catalog cache is not complete");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("aborts as an anomaly before writes when candidate volume is too high", async () => {
    process.env.CLEANUP_ANOMALY_MAX = "1";
    catalogProducts = {
      p1: activeProduct(),
      p2: activeProduct({ sku: "other/s2601" }),
    };

    const res = makeRes();
    await handler(makeReq({ auth: true }), res);

    expect(res.body).toMatchObject({ anomalyAborted: true, candidates: 2 });
    expect(setLsHealth).toHaveBeenCalledWith("warning", expect.stringContaining("cleanup anomaly"));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("deactivates candidates and writes a dated KV audit log", async () => {
    process.env.CLEANUP_MAX_WRITES = "5";
    catalogProducts = {
      p1: activeProduct({ sku: "stale/s2601" }),
      p2: activeProduct({ sku: "stock/s2601" }),
      p3: activeProduct({ sku: "recent/s2601" }),
    };
    inventoryCache = { onHand: { p2: 2 } };
    salesAgg = { p3: { lastSoldAt: Date.now() } };

    const res = makeRes();
    await handler(makeReq({ auth: true }), res);

    expect(res.body).toMatchObject({ complete: true, candidates: 1, written: 1 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain("/2026-04/products/p1");
    const logKey = [...mockKv._store.keys()].find((key) => key.startsWith("scan:cleanup:log:"));
    expect(mockKv._store.get(logKey)).toEqual([
      expect.objectContaining({ id: "p1", sku: "stale/s2601", action: "deactivate" }),
    ]);
  });
});
