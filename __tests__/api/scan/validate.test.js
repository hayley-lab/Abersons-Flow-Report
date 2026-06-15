// Smoke tests for the validation harness handler (pages/api/scan/validate.js).
//
// Lives outside pages/ so Next doesn't compile it as a route. Covers the
// always-JSON contract, method + auth gating (CRON_SECRET bearer OR session),
// season gating, the history read short-circuit, the 404-no-data path, and a
// full run that returns the drift verdict. The heavy LS/KV collaborators are
// mocked; the orchestration branches are what we exercise here.

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
    },
  };
});

jest.mock("../../../lib/ls-auth", () => ({
  getLsToken: jest.fn(async () => "test-token"),
  lsBase: jest.fn(() => "https://test.retail.lightspeed.app/api"),
}));

jest.mock("../../../lib/ls-fetch", () => ({
  makeLsFetch: jest.fn(() => {
    const fn = jest.fn(async () => ({ data: [] }));
    fn.callStats = { total: 0, byFamily: {} };
    return fn;
  }),
  isLsDeadlineError: jest.fn(() => false),
}));

jest.mock("../../../lib/flow-rollup", () => ({
  buildAllRows: jest.fn(() => [{ pid: "p1", inventoryMismatch: false }]),
  rollup: jest.fn(() => ({ summaryRows: [], deptVendors: {} })),
  rowsForVendor: jest.fn((rows) => rows),
}));

jest.mock("../../../lib/consignment-store", () => ({
  loadConsignEntries: jest.fn(async () => []),
  seasonConsignmentBuckets: jest.fn(() => ({})),
}));

jest.mock("../../../lib/sales-store", () => ({
  loadSalesAgg: jest.fn(async () => ({})),
  projectSeasonSales: jest.fn(() => ({})),
}));

jest.mock("../../../lib/scan-data-store", () => ({
  loadScanData: jest.fn(async () => null),
}));

jest.mock("../../../lib/report-validate", () => ({
  buildValidationReport: jest.fn(() => ({ counts: { checkedProducts: 1 } })),
  DEFAULT_THRESHOLDS: {},
  evaluateDrift: jest.fn(() => ({ tripped: false, reasons: [] })),
  pidToSkuFromRows: jest.fn(() => ({})),
  samplePids: jest.fn((pids) => pids),
}));

jest.mock("../../../lib/validation-history", () => ({
  loadValidationHistory: jest.fn(async () => ({ latest: null, history: [] })),
  persistValidation: jest.fn(async () => undefined),
}));

import { loadScanData } from "../../../lib/scan-data-store";
import { evaluateDrift, buildValidationReport } from "../../../lib/report-validate";
import { loadValidationHistory } from "../../../lib/validation-history";
import handler from "../../../pages/api/scan/validate";

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

function makeReq({ method = "GET", query = {}, auth = false } = {}) {
  return {
    method,
    query,
    headers: auth ? { authorization: "Bearer test-secret" } : {},
  };
}

describe("scan/validate handler", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = "test-secret";
  });

  beforeEach(() => {
    sessionAuthed = false;
    loadScanData.mockReset();
    loadScanData.mockResolvedValue(null);
    evaluateDrift.mockClear();
    buildValidationReport.mockClear();
    loadValidationHistory.mockClear();
  });

  it("405s on a non-GET/POST method", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "DELETE" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("401s when there is neither a CRON_SECRET bearer nor an authed session", async () => {
    const res = makeRes();
    await handler(makeReq({ query: { season: "fall26" } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });
  });

  it("400s (authed) when season is missing", async () => {
    const res = makeRes();
    await handler(makeReq({ query: {}, auth: true }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "season required" });
  });

  it("returns the persisted history trend on history=1 without running the harness", async () => {
    loadValidationHistory.mockResolvedValue({ latest: { drift: false }, history: [{ ts: 1 }] });
    const res = makeRes();
    await handler(makeReq({ query: { season: "fall26", history: "1" }, auth: true }), res);

    expect(res.body).toEqual({
      season: "fall26",
      latest: { drift: false },
      history: [{ ts: 1 }],
    });
    expect(buildValidationReport).not.toHaveBeenCalled();
  });

  it("404s when there is no scan data and no override for the season", async () => {
    const res = makeRes();
    await handler(makeReq({ query: { season: "fall26" }, auth: true }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "No scan data for season" });
  });

  it("runs the full harness and returns the drift verdict (drift tripped)", async () => {
    loadScanData.mockResolvedValue({ seasonPids: ["p1"], ts: 1000 });
    evaluateDrift.mockReturnValue({ tripped: true, reasons: [{ detail: "retail drift" }] });

    const res = makeRes();
    await handler(makeReq({ query: { season: "fall26" }, auth: true }), res);

    expect(res.statusCode).toBe(200);
    expect(buildValidationReport).toHaveBeenCalled();
    expect(res.body).toMatchObject({
      drift: { tripped: true },
      persisted: true,
      vendor: null,
    });
  });
});
