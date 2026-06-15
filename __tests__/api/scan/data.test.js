// Smoke tests for the report read path (pages/api/scan/data.js).
//
// Lives outside pages/ so Next doesn't compile it as a route. Guards the
// contract the UI depends on: always JSON, auth + season gating, the
// since/notModified short-circuit, the normal rollup success shape, and the
// rollup-degraded fallback (buildAllRows/rollup must never bubble a throw).

let sessionAuthed = true;
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
    },
  };
});

jest.mock("../../../lib/scan-data-store", () => ({
  loadScanData: jest.fn(async () => null),
}));

jest.mock("../../../lib/flow-rollup", () => ({
  buildAllRows: jest.fn(() => [{ pid: "p1", ordered: 1 }]),
  rollup: jest.fn(() => ({
    summaryRows: [{ id: "d1", name: "Dept One" }],
    deptVendors: { d1: [{ id: "v1", name: "Vendor One" }] },
  })),
}));

jest.mock("../../../lib/ls-auth", () => ({
  getLsHealth: jest.fn(async () => ({ ok: true, ts: 123 })),
}));

import { kv as mockKv } from "@vercel/kv";
import { loadScanData } from "../../../lib/scan-data-store";
import { buildAllRows, rollup } from "../../../lib/flow-rollup";
import handler from "../../../pages/api/scan/data";

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
  return res;
}

function makeReq(query = {}) {
  return { method: "GET", query, headers: {} };
}

describe("scan/data handler", () => {
  beforeEach(() => {
    sessionAuthed = true;
    mockKv._store.clear();
    mockKv.get.mockClear();
    loadScanData.mockReset();
    loadScanData.mockResolvedValue(null);
    buildAllRows.mockClear();
    rollup.mockClear();
    buildAllRows.mockImplementation(() => [{ pid: "p1", ordered: 1 }]);
    rollup.mockImplementation(() => ({
      summaryRows: [{ id: "d1", name: "Dept One" }],
      deptVendors: { d1: [{ id: "v1", name: "Vendor One" }] },
    }));
  });

  it("returns 401 JSON when the session is not authed", async () => {
    sessionAuthed = false;
    const res = makeRes();
    await handler(makeReq({ season: "fall26" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });
  });

  it("returns 400 JSON when season is missing", async () => {
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "season required" });
  });

  it("short-circuits with notModified when since >= data.ts and the job is done", async () => {
    loadScanData.mockResolvedValue({ ts: 1000, seasonPids: ["p1"] });
    mockKv._store.set("scan:job:fall26", { phase: "done", progress: "", ts: 1000 });
    const res = makeRes();
    await handler(makeReq({ season: "fall26", since: "2000" }), res);

    expect(res.body).toMatchObject({ notModified: true, data: null });
    // The rollup must not run on the short-circuit path.
    expect(buildAllRows).not.toHaveBeenCalled();
  });

  it("runs the rollup and returns summary/deptVendors/rows on the success path", async () => {
    loadScanData.mockResolvedValue({ ts: 5000, seasonPids: ["p1"] });
    const res = makeRes();
    await handler(makeReq({ season: "fall26" }), res);

    expect(res.statusCode).toBe(200);
    expect(buildAllRows).toHaveBeenCalled();
    expect(res.body.data).toMatchObject({
      season: "fall26",
      summaryRows: [{ id: "d1", name: "Dept One" }],
      rows: [{ pid: "p1", ordered: 1 }],
    });
    expect(res.body).toMatchObject({ rollupDegraded: false, totalsDegraded: false });
    expect(res.body.lsHealth).toEqual({ ok: true, ts: 123 });
  });

  it("degrades (not throws) to rollupDegraded when buildAllRows fails", async () => {
    loadScanData.mockResolvedValue({ ts: 5000, seasonPids: ["p1"] });
    buildAllRows.mockImplementation(() => {
      throw new Error("rollup blew up");
    });
    // The handler logs the rollup error on purpose; keep test output clean.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ season: "fall26" }), res); // must resolve, never throw
    errSpy.mockRestore();

    expect(res.statusCode).toBe(200);
    expect(res.body.mergeError).toBe("rollup blew up");
    expect(res.body).toMatchObject({ rollupDegraded: true, totalsDegraded: true });
    expect(res.body.data).toMatchObject({ rollupDegraded: true });
  });
});
