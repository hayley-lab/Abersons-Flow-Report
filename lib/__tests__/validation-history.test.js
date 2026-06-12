// Unit tests for the persisted validation drift-history helpers. These never
// touch live KV — a tiny in-memory mock stands in — and verify the compact
// record shape, the bounded rolling trim, and the read-modify-write persist.
import {
  VALIDATION_HISTORY_MAX,
  VALIDATION_HISTORY_TTL_SECONDS,
  validationLatestKey,
  validationHistoryKey,
  toHistoryRecord,
  appendHistory,
  persistValidation,
  loadValidationHistory,
} from "../validation-history";

function createKv() {
  const values = new Map();
  const calls = { set: [], get: [] };
  return {
    calls,
    values,
    async get(key) {
      calls.get.push(key);
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value, options) {
      calls.set.push({ key, value, options });
      values.set(key, value);
    },
  };
}

function sampleReport(overrides = {}) {
  return {
    season: "spring26",
    checkedAt: 1700000000000,
    mode: "sample",
    drift: {
      tripped: true,
      reasons: [{ code: "hard-qty-mismatch", detail: "2 hard quantity mismatch(es)" }],
    },
    counts: {
      totalRows: 500,
      datatailOnly: 10,
      manualAdjustment: 3,
      verifiableProducts: 487,
      checkedProducts: 150,
      driftedProducts: 4,
      mismatchCount: 6,
      hardQtyMismatches: 2,
      seasonReportedRetail: 100000,
      seasonRetailDrift: 750,
      seasonRetailDriftRatio: 0.0075,
    },
    // Heavy arrays that must NOT survive into the compact record.
    mismatches: [{ pid: "p1", field: "onHand" }],
    skipped: [{ pid: "p2", reason: "datatail-only" }],
    ...overrides,
  };
}

describe("toHistoryRecord", () => {
  it("keeps the compact summary and drops the per-row arrays", () => {
    const rec = toHistoryRecord(sampleReport());
    expect(rec).toMatchObject({
      season: "spring26",
      checkedAt: 1700000000000,
      mode: "sample",
      drift: {
        tripped: true,
        reasons: [{ code: "hard-qty-mismatch", detail: "2 hard quantity mismatch(es)" }],
      },
    });
    expect(rec.counts.driftedProducts).toBe(4);
    expect(rec.counts.hardQtyMismatches).toBe(2);
    expect(rec.counts.seasonRetailDriftRatio).toBeCloseTo(0.0075, 6);
    // The heavy arrays are excluded to keep the record small.
    expect(rec.mismatches).toBeUndefined();
    expect(rec.skipped).toBeUndefined();
  });

  it("returns null for a missing report and fills sane defaults", () => {
    expect(toHistoryRecord(null)).toBeNull();
    const rec = toHistoryRecord({ season: "fall26" });
    expect(rec.mode).toBe("full");
    expect(rec.drift).toEqual({ tripped: false, reasons: [] });
    expect(rec.counts.checkedProducts).toBe(0);
  });
});

describe("appendHistory", () => {
  it("appends to an empty/nullish history", () => {
    expect(appendHistory(null, { checkedAt: 1 })).toEqual([{ checkedAt: 1 }]);
    expect(appendHistory(undefined, { checkedAt: 2 })).toEqual([{ checkedAt: 2 }]);
  });

  it("drops the oldest entries beyond the bound", () => {
    let hist = [];
    for (let i = 0; i < VALIDATION_HISTORY_MAX + 5; i++) {
      hist = appendHistory(hist, { checkedAt: i });
    }
    expect(hist).toHaveLength(VALIDATION_HISTORY_MAX);
    // The earliest 5 were trimmed; the list keeps the most recent N in order.
    expect(hist[0].checkedAt).toBe(5);
    expect(hist[hist.length - 1].checkedAt).toBe(VALIDATION_HISTORY_MAX + 4);
  });

  it("respects a custom max", () => {
    const hist = appendHistory([{ checkedAt: 1 }, { checkedAt: 2 }], { checkedAt: 3 }, 2);
    expect(hist).toEqual([{ checkedAt: 2 }, { checkedAt: 3 }]);
  });
});

describe("persistValidation", () => {
  it("writes the latest record + appends to history with the TTL", async () => {
    const kv = createKv();
    const { record, history } = await persistValidation(kv, "spring26", sampleReport());

    expect(record.season).toBe("spring26");
    expect(history).toHaveLength(1);

    const latest = kv.values.get(validationLatestKey("spring26"));
    const hist = kv.values.get(validationHistoryKey("spring26"));
    expect(latest).toEqual(record);
    expect(hist).toEqual([record]);

    // Both writes use the documented long TTL so the trend survives day to day.
    for (const c of kv.calls.set) {
      expect(c.options).toEqual({ ex: VALIDATION_HISTORY_TTL_SECONDS });
    }
  });

  it("appends across runs and trims to the bound", async () => {
    const kv = createKv();
    for (let i = 0; i < VALIDATION_HISTORY_MAX + 3; i++) {
      await persistValidation(kv, "fall26", sampleReport({ checkedAt: i }));
    }
    const hist = kv.values.get(validationHistoryKey("fall26"));
    expect(hist).toHaveLength(VALIDATION_HISTORY_MAX);
    expect(hist[0].checkedAt).toBe(3);
    expect(hist[hist.length - 1].checkedAt).toBe(VALIDATION_HISTORY_MAX + 2);
    // Latest always mirrors the most recent run.
    expect(kv.values.get(validationLatestKey("fall26")).checkedAt).toBe(VALIDATION_HISTORY_MAX + 2);
  });

  it("parses a stringified history blob from KV", async () => {
    const kv = createKv();
    kv.values.set(validationHistoryKey("spring26"), JSON.stringify([{ checkedAt: 1 }]));
    const { history } = await persistValidation(kv, "spring26", sampleReport({ checkedAt: 2 }));
    expect(history.map((h) => h.checkedAt)).toEqual([1, 2]);
  });

  it("is a no-op record for a missing report", async () => {
    const kv = createKv();
    const out = await persistValidation(kv, "spring26", null);
    expect(out.record).toBeNull();
    expect(kv.calls.set).toHaveLength(0);
  });
});

describe("loadValidationHistory", () => {
  it("returns the latest + history, coercing a non-array to []", async () => {
    const kv = createKv();
    await persistValidation(kv, "spring26", sampleReport());
    const out = await loadValidationHistory(kv, "spring26");
    expect(out.latest.season).toBe("spring26");
    expect(out.history).toHaveLength(1);
  });

  it("returns null/empty when nothing is persisted", async () => {
    const kv = createKv();
    const out = await loadValidationHistory(kv, "nope");
    expect(out.latest).toBeNull();
    expect(out.history).toEqual([]);
  });

  it("parses stringified KV values", async () => {
    const kv = createKv();
    kv.values.set(
      validationLatestKey("fall26"),
      JSON.stringify({ season: "fall26", checkedAt: 5 })
    );
    kv.values.set(validationHistoryKey("fall26"), JSON.stringify([{ checkedAt: 5 }]));
    const out = await loadValidationHistory(kv, "fall26");
    expect(out.latest).toEqual({ season: "fall26", checkedAt: 5 });
    expect(out.history).toEqual([{ checkedAt: 5 }]);
  });
});
