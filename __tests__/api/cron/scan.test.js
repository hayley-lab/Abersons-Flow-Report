// Smoke tests for the cron scan orchestrator handler (pages/api/cron/scan.js).
//
// Lives outside pages/ so Next doesn't compile it as a route. The pure
// scheduling helpers are unit-tested in scan-orchestrator.test.js; this drives
// the HANDLER end-to-end with the real orchestrator + real SEASONS, mocking
// only KV, the cache-meta loaders, and global fetch. It guards: method/auth
// gating, the 503-JSON-on-KV-failure path, and — tying 1b together — that a
// step reporting phase:"error" surfaces its message in the driver results.

let sessionAuthed = false;
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
      set: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
    },
  };
});

// All shared caches report complete so the drives are skipped on the driver
// path (loopInternally === false) and the handler proceeds straight to stepping.
jest.mock("../../../lib/catalog-store", () => ({
  loadCatalogMeta: jest.fn(async () => ({ complete: true })),
}));
jest.mock("../../../lib/sales-store", () => ({
  loadSalesStoreMeta: jest.fn(async () => ({ complete: true })),
}));
jest.mock("../../../lib/consignment-store", () => ({
  loadConsignMeta: jest.fn(async () => ({ complete: true })),
}));
jest.mock("../../../lib/inventory-ledger", () => ({
  loadInventoryMeta: jest.fn(async () => ({ complete: true })),
}));
jest.mock("../../../lib/scan-data-store", () => ({
  loadScanDataSummary: jest.fn(async () => null),
}));

import { kv as mockKv } from "@vercel/kv";
import handler from "../../../pages/api/cron/scan";

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

function makeReq({ method = "POST", query = {}, auth = false } = {}) {
  return {
    method,
    query,
    headers: auth ? { authorization: "Bearer test-secret" } : {},
  };
}

describe("cron/scan handler", () => {
  let warnSpy;
  let errSpy;

  beforeAll(() => {
    process.env.CRON_SECRET = "test-secret";
  });

  beforeEach(() => {
    sessionAuthed = false;
    mockKv.get.mockClear();
    mockKv.get.mockImplementation(async (key) =>
      mockKv._store.has(key) ? mockKv._store.get(key) : null
    );
    mockKv.set.mockClear();
    mockKv.set.mockImplementation(async (key, value) => {
      mockKv._store.set(key, value);
    });
    mockKv.del.mockClear();
    mockKv.del.mockImplementation(async (key) => {
      mockKv._store.delete(key);
    });
    // The handler logs progress/errors on purpose; keep test output clean.
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errSpy.mockRestore();
    delete global.fetch;
  });

  it("405s on a non-GET/POST method", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "PUT" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("401s when there is neither a CRON_SECRET bearer nor an authed session", async () => {
    const res = makeRes();
    await handler(makeReq({ query: { force: "1" } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 503 JSON (never throws) when the season KV read fails", async () => {
    mockKv.get.mockRejectedValue(new Error("kv down"));
    const res = makeRes();
    await handler(makeReq({ query: { force: "1" }, auth: true }), res); // must resolve

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "KV read failed: kv down" });
  });

  it("surfaces a step's phase:'error' message in the driver results (force=1 path)", async () => {
    // A step that responds 200 with phase:"error" must carry its error message
    // through to the driver response so the UI can show WHY a season failed.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ phase: "error", error: "boom" }),
    }));

    const res = makeRes();
    await handler(makeReq({ query: { force: "1" }, auth: true }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    // The driver path stepped at least one season via /api/scan/step.
    expect(global.fetch).toHaveBeenCalled();
    expect(global.fetch.mock.calls[0][0]).toContain("/api/scan/step");
    const errored = res.body.results.filter((r) => r.action === "error");
    expect(errored.length).toBeGreaterThan(0);
    expect(errored.every((r) => r.error === "boom")).toBe(true);
  });

  it("refreshes complete shared caches once before advancing seasons", async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes("/api/scan/step")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ phase: "done", mode: "full" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ cacheComplete: true, complete: true }),
      };
    });

    const res = makeRes();
    await handler(makeReq({ query: { driver: "1", refresh: "1", restart: "1" }, auth: true }), res);

    const urls = global.fetch.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("/api/scan/catalog"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/scan/sales-cache"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/scan/consign-cache"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/scan/inventory-cache"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/scan/step"))).toBe(true);
    expect(res.body.cacheRefreshPending).toBe(false);
  });

  it("keeps an undrained cache pending for the next driver call", async () => {
    let catalogCalls = 0;
    global.fetch = jest.fn(async (url) => {
      if (url.includes("/api/scan/catalog")) {
        catalogCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            cacheComplete: true,
            complete: catalogCalls > 1,
          }),
        };
      }
      if (url.includes("/api/scan/step")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ phase: "done", mode: "full" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ cacheComplete: true, complete: true }),
      };
    });

    const first = makeRes();
    await handler(makeReq({ query: { driver: "1", refresh: "1" }, auth: true }), first);
    expect(first.body.cacheRefreshPending).toBe(true);
    expect(first.body.allDone).toBe(false);

    const second = makeRes();
    await handler(makeReq({ query: { driver: "1" }, auth: true }), second);
    expect(catalogCalls).toBe(2);
    expect(second.body.cacheRefreshPending).toBe(false);
    expect(second.body.allDone).toBe(true);
  });
});
