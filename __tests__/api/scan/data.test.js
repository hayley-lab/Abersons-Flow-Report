// Tests for the report read path (pages/api/scan/data.js).
//
// Lives outside pages/ so Next doesn't compile it as a route. Guards the
// contract the UI depends on: auth + season gating, the cheap since/notModified
// short-circuit, the write-through cache (summary hit, dept-rows hit, and
// miss+recompute), and the rollup-degraded fallback.

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
      incr: jest.fn(async () => 1),
    },
  };
});

jest.mock("../../../lib/scan-data-store", () => ({
  loadScanData: jest.fn(async () => null),
  loadScanDataSummary: jest.fn(async () => null),
  loadReportSummary: jest.fn(async () => null),
  saveReportSummary: jest.fn(async () => undefined),
  loadReportDeptRows: jest.fn(async () => null),
  saveReportDeptRows: jest.fn(async () => undefined),
  loadReportEpoch: jest.fn(async () => 0),
  reportCacheTag: (ts, epoch) => `${ts == null ? "none" : ts}:${epoch == null ? 0 : epoch}`,
}));

jest.mock("../../../lib/report-compute", () => ({
  computeReport: jest.fn(() => ({
    rows: [{ pid: "p1", deptId: "d1" }],
    summaryRows: [{ id: "d1", name: "Dept One" }],
    deptVendors: { d1: [{ id: "v1", name: "Vendor One" }] },
    health: { summary: { totalRows: 1 }, adjustedCount: 0, uncategorized: [] },
  })),
  groupRowsByDept: jest.fn((rows) => ({ d1: rows })),
}));

jest.mock("../../../lib/ls-auth", () => ({
  getLsHealth: jest.fn(async () => ({ ok: true, ts: 123 })),
}));

jest.mock("../../../lib/sql-report-store", () => ({
  readSqlReportView: jest.fn(async () => null),
  maybeUpsertSqlReport: jest.fn(async () => ({ ok: false, skipped: true })),
}));

import { kv as mockKv } from "@vercel/kv";
import {
  loadScanData,
  loadScanDataSummary,
  loadReportSummary,
  saveReportSummary,
  loadReportDeptRows,
  saveReportDeptRows,
} from "../../../lib/scan-data-store";
import { computeReport } from "../../../lib/report-compute";
import { readSqlReportView } from "../../../lib/sql-report-store";
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
    loadScanData.mockReset().mockResolvedValue(null);
    loadScanDataSummary.mockReset().mockResolvedValue(null);
    loadReportSummary.mockReset().mockResolvedValue(null);
    saveReportSummary.mockClear();
    loadReportDeptRows.mockReset().mockResolvedValue(null);
    saveReportDeptRows.mockClear();
    readSqlReportView.mockReset().mockResolvedValue(null);
    computeReport.mockClear().mockImplementation(() => ({
      rows: [{ pid: "p1", deptId: "d1" }],
      summaryRows: [{ id: "d1", name: "Dept One" }],
      deptVendors: { d1: [{ id: "v1", name: "Vendor One" }] },
      health: { summary: { totalRows: 1 }, adjustedCount: 0, uncategorized: [] },
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

  it("short-circuits with notModified (no heavy read) when since >= ts and job done", async () => {
    loadScanDataSummary.mockResolvedValue({ ts: 1000 });
    mockKv._store.set("scan:job:fall26", { phase: "done", progress: "", ts: 1000 });
    const res = makeRes();
    await handler(makeReq({ season: "fall26", since: "2000" }), res);

    expect(res.body).toMatchObject({ notModified: true, data: null });
    expect(loadReportSummary).not.toHaveBeenCalled();
    expect(loadScanData).not.toHaveBeenCalled();
    expect(computeReport).not.toHaveBeenCalled();
  });

  it("serves the cached summary blob on a tag hit without recomputing", async () => {
    loadScanDataSummary.mockResolvedValue({ ts: 5000 });
    loadReportSummary.mockResolvedValue({
      tag: "5000:0",
      hasOverride: true,
      deptIds: ["d1"],
      data: { ts: 5000, season: "fall26", summaryRows: [{ id: "d1" }], deptVendors: {} },
    });
    const res = makeRes();
    await handler(makeReq({ season: "fall26", view: "summary" }), res);

    expect(res.body.data).toMatchObject({ ts: 5000, summaryRows: [{ id: "d1" }] });
    expect(res.body.hasOverride).toBe(true);
    expect(loadScanData).not.toHaveBeenCalled();
    expect(computeReport).not.toHaveBeenCalled();
  });

  it("serves SQL data before checking the KV report cache when SQL is enabled", async () => {
    loadScanDataSummary.mockResolvedValue({ ts: 5000 });
    readSqlReportView.mockResolvedValue({
      ts: 5000,
      season: "fall26",
      summaryRows: [{ id: "sql" }],
      deptVendors: {},
      hasOverride: true,
    });
    const res = makeRes();
    await handler(makeReq({ season: "fall26", view: "summary" }), res);

    expect(res.body).toMatchObject({
      source: "sql",
      hasOverride: true,
      data: { summaryRows: [{ id: "sql" }] },
    });
    expect(loadReportSummary).not.toHaveBeenCalled();
    expect(loadScanData).not.toHaveBeenCalled();
  });

  it("serves one department's rows on a drows tag hit", async () => {
    loadScanDataSummary.mockResolvedValue({ ts: 5000 });
    loadReportSummary.mockResolvedValue({ tag: "5000:0", hasOverride: false, data: {} });
    loadReportDeptRows.mockResolvedValue({
      tag: "5000:0",
      ts: 5000,
      deptId: "d1",
      rows: [{ pid: "p1" }],
    });
    const res = makeRes();
    await handler(makeReq({ season: "fall26", view: "drows", dept: "d1" }), res);

    expect(res.body.data).toMatchObject({ deptId: "d1", rows: [{ pid: "p1" }] });
    expect(computeReport).not.toHaveBeenCalled();
  });

  it("recomputes and writes through the cache on a miss", async () => {
    loadScanDataSummary.mockResolvedValue({ ts: 5000 });
    loadReportSummary.mockResolvedValue(null);
    loadScanData.mockResolvedValue({ ts: 5000, seasonPids: ["p1"] });
    const res = makeRes();
    await handler(makeReq({ season: "fall26" }), res);

    expect(computeReport).toHaveBeenCalled();
    expect(saveReportSummary).toHaveBeenCalled();
    expect(saveReportDeptRows).toHaveBeenCalledWith(
      mockKv,
      "fall26",
      "d1",
      expect.objectContaining({ tag: "5000:0", deptId: "d1" })
    );
    expect(res.body.data).toMatchObject({ summaryRows: [{ id: "d1", name: "Dept One" }] });
    expect(res.body).toMatchObject({ rollupDegraded: false });
  });

  it("returns empty data when there is neither scan data nor override", async () => {
    loadScanDataSummary.mockResolvedValue(null);
    loadReportSummary.mockResolvedValue(null);
    loadScanData.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq({ season: "spring27" }), res);

    expect(res.body.data).toBeNull();
    expect(computeReport).not.toHaveBeenCalled();
  });

  it("degrades (not throws) to rollupDegraded when computeReport fails", async () => {
    loadScanDataSummary.mockResolvedValue({ ts: 5000 });
    loadReportSummary.mockResolvedValue(null);
    loadScanData.mockResolvedValue({ ts: 5000, seasonPids: ["p1"] });
    computeReport.mockImplementation(() => {
      throw new Error("rollup blew up");
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    await handler(makeReq({ season: "fall26" }), res);
    errSpy.mockRestore();

    expect(res.statusCode).toBe(200);
    expect(res.body.mergeError).toBe("rollup blew up");
    expect(res.body).toMatchObject({ rollupDegraded: true, totalsDegraded: true });
    expect(res.body.data).toMatchObject({ rollupDegraded: true });
  });
});
