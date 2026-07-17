const mockRawData = {
  seasonPids: ["pid-1"],
  pidToSku: { "pid-1": "style/s2701" },
};
const mockOverlay = { "pid-1": { ordered: 2, received: 1 } };
const mockComputeReport = jest.fn(() => ({
  summaryRows: [],
  deptVendors: {},
  rows: [],
}));
const mockLoadSeasonConsignOverlay = jest.fn(async () => mockOverlay);

jest.mock("../report-compute", () => ({
  computeReport: (...args) => mockComputeReport(...args),
}));
jest.mock("../scan-data-store", () => ({
  loadScanData: jest.fn(async () => mockRawData),
}));
jest.mock("../override-store", () => ({
  loadOverride: jest.fn(async () => null),
}));
jest.mock("../db", () => ({
  getSql: jest.fn(() => ({})),
  hasSqlDatabase: jest.fn(() => true),
}));
jest.mock("../sql-report-store", () => ({
  readSqlFull: jest.fn(async () => ({
    summaryRows: [],
    deptVendors: {},
    rows: [],
  })),
}));
jest.mock("../consignment-store", () => ({
  loadSeasonConsignOverlay: (...args) => mockLoadSeasonConsignOverlay(...args),
}));

import { verifySqlSeason } from "../report-verify";

describe("verifySqlSeason", () => {
  beforeEach(() => {
    mockComputeReport.mockClear();
    mockLoadSeasonConsignOverlay.mockClear();
  });

  it("compares SQL against the current consignment-backed KV report", async () => {
    const kv = {};

    await expect(verifySqlSeason(kv, "spring27")).resolves.toMatchObject({ ok: true });
    expect(mockLoadSeasonConsignOverlay).toHaveBeenCalledWith(kv, "spring27", {
      seasonPids: mockRawData.seasonPids,
      pidToSku: mockRawData.pidToSku,
    });
    expect(mockComputeReport).toHaveBeenCalledWith(mockRawData, null, "spring27", {
      consignByPid: mockOverlay,
    });
  });
});
