import {
  CONSIGN_META_KEY,
  consignSeasonKey,
  consignShardKey,
  loadConsignEntries,
  seasonConsignmentBuckets,
  syncConsignmentStore,
  writeSeasonConsignBuckets,
} from "../consignment-store";
import { DEFAULT_SHARD_COUNT, shardForPid } from "../catalog-store";
import { seasonScanDateRange } from "../flow-math";

function createKv() {
  const values = new Map();
  const calls = { set: [], del: [] };
  return {
    values,
    calls,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, options) {
      calls.set.push({ key, value, options });
      values.set(key, value);
    },
    async del(key) {
      calls.del.push(key);
      values.delete(key);
    },
  };
}

function header(id, type, version, createdAt, extra = {}) {
  return { id, type, version, created_at: createdAt, ...extra };
}

function lineItem(productId, count, received = 0) {
  return { product_id: productId, count, received };
}

// Routing lsFetch: serves header pages per type and line items per consignment.
function makeLsFetch(headersByType, itemsById) {
  return jest.fn(async (path) => {
    const itemsMatch = path.match(/2\.0\/consignments\/([^/]+)\/products/);
    if (itemsMatch) {
      const id = itemsMatch[1];
      return { data: itemsById[id] || [] };
    }
    const typeMatch = path.match(/type=([A-Z_]+)/);
    const type = typeMatch ? typeMatch[1] : "SUPPLIER";
    // No cursor in path -> first (and only) page; otherwise drained.
    if (path.includes("after=")) return { data: [] };
    return { data: headersByType[type] || [] };
  });
}

// Cursor-aware lsFetch: slices headers by the `after=` version and page_size so
// a header set larger than HEADER_PAGE_SIZE genuinely requires multiple pages.
function makeCursorAwareLsFetch(headersByType, itemsById, pageSize = 200) {
  return jest.fn(async (path) => {
    const itemsMatch = path.match(/2\.0\/consignments\/([^/]+)\/products/);
    if (itemsMatch) {
      return { data: itemsById[itemsMatch[1]] || [] };
    }
    const typeMatch = path.match(/type=([A-Z_]+)/);
    const type = typeMatch ? typeMatch[1] : "SUPPLIER";
    const afterMatch = path.match(/after=(\d+)/);
    const after = afterMatch ? Number(afterMatch[1]) : 0;
    const sorted = (headersByType[type] || []).slice().sort((a, b) => a.version - b.version);
    const page = sorted.filter((h) => h.version > after).slice(0, pageSize);
    const maxVersion = page.reduce((mx, h) => Math.max(mx, h.version), 0);
    return { data: page, version: { max: maxVersion } };
  });
}

describe("syncConsignmentStore cold build", () => {
  it("pages SUPPLIER + RETURN headers, fetches line items, and stores sharded entries", async () => {
    const kv = createKv();
    const headersByType = {
      SUPPLIER: [header("c1", "SUPPLIER", 10, "2026-01-15")],
      RETURN: [header("c2", "RETURN", 20, "2026-03-01")],
    };
    const itemsById = {
      c1: [lineItem("p1", 5, 3), lineItem("p2", 2, 2)],
      c2: [lineItem("p1", 1)],
    };
    const lsFetch = makeLsFetch(headersByType, itemsById);

    const result = await syncConsignmentStore(kv, lsFetch, { reset: true, dateFrom: "2025-01-01" });

    expect(result.complete).toBe(true);
    expect(result.added).toBe(2);

    const entries = await loadConsignEntries(kv);
    expect(entries.c1).toMatchObject({ type: "SUPPLIER", version: 10, date: "2026-01-15" });
    expect(entries.c1.perPid.p1).toEqual({ qtyOrdered: 5, qtyReceived: 3, qtyReturned: 0 });
    expect(entries.c2.perPid.p1).toEqual({ qtyOrdered: 0, qtyReceived: 0, qtyReturned: 1 });

    const meta = kv.values.get(CONSIGN_META_KEY);
    expect(meta.complete).toBe(true);
    expect(meta.typeDone).toEqual({ SUPPLIER: true, RETURN: true });

    // Entry lands in its deterministic shard.
    const shard = shardForPid("c1", DEFAULT_SHARD_COUNT);
    expect(kv.values.get(consignShardKey(shard))).toHaveProperty("c1");
  });

  // Regression for C1 (loop stopped after page 1 because the drain check
  // compared the page max against a cursor mutated to that same value).
  it("pages every header across a > HEADER_PAGE_SIZE set and completes", async () => {
    const kv = createKv();
    const supplier = [];
    const itemsById = {};
    for (let i = 1; i <= 250; i++) {
      const id = `s${i}`;
      supplier.push(header(id, "SUPPLIER", i, "2026-01-15"));
      itemsById[id] = [lineItem(`p${i}`, 1, 1)];
    }
    const lsFetch = makeCursorAwareLsFetch({ SUPPLIER: supplier, RETURN: [] }, itemsById);

    const result = await syncConsignmentStore(kv, lsFetch, { reset: true, dateFrom: "2025-01-01" });

    expect(result.complete).toBe(true);
    const entries = await loadConsignEntries(kv);
    expect(Object.keys(entries)).toHaveLength(250);
    for (let i = 1; i <= 250; i++) {
      expect(entries[`s${i}`]).toBeDefined();
    }
    // Required at least 2 header pages (page 1 = 200, page 2 = 50).
    const headerCalls = lsFetch.mock.calls.filter(([p]) => !p.includes("/products"));
    expect(headerCalls.length).toBeGreaterThanOrEqual(2);
  });
});

// Regression for C2 (a mid-page deadline persisted the whole page's max version,
// so resume skipped every header that had not been processed before the break).
describe("syncConsignmentStore deadline interrupt + resume", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("checkpoints the last fully-processed header and resumes with no gaps", async () => {
    const kv = createKv();
    const supplier = [
      header("c10", "SUPPLIER", 10, "2026-01-15"),
      header("c20", "SUPPLIER", 20, "2026-01-15"),
      header("c30", "SUPPLIER", 30, "2026-01-15"),
      header("c40", "SUPPLIER", 40, "2026-01-15"),
      header("c50", "SUPPLIER", 50, "2026-01-15"),
    ];
    const itemsById = {
      c10: [lineItem("p10", 1, 1)],
      c20: [lineItem("p20", 1, 1)],
      c30: [lineItem("p30", 1, 1)],
      c40: [lineItem("p40", 1, 1)],
      c50: [lineItem("p50", 1, 1)],
    };

    // Two Date.now() calls precede the header loop (the type-guard and the
    // while-guard); the next two header pre-checks pass, the 5th trips. So the
    // first two headers (v10, v20) are fully processed before the interrupt.
    let calls = 0;
    jest.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      return calls <= 4 ? 0 : 1_000_000;
    });

    const first = makeCursorAwareLsFetch({ SUPPLIER: supplier, RETURN: [] }, itemsById);
    const r1 = await syncConsignmentStore(kv, first, {
      reset: true,
      deadline: 1,
      dateFrom: "2025-01-01",
    });
    expect(r1.complete).toBe(false);

    // Checkpoint is the last fully-processed header version (20), NOT the page
    // max (50). Before the fix this was 50 and v30/40/50 were lost on resume.
    const meta = kv.values.get(CONSIGN_META_KEY);
    expect(meta.versionByType.SUPPLIER).toBe(20);

    const afterFirst = await loadConsignEntries(kv);
    expect(Object.keys(afterFirst).sort()).toEqual(["c10", "c20"]);

    // Resume with a real (non-tripping) clock; remaining headers must be captured.
    jest.restoreAllMocks();
    const second = makeCursorAwareLsFetch({ SUPPLIER: supplier, RETURN: [] }, itemsById);
    const r2 = await syncConsignmentStore(kv, second, { dateFrom: "2025-01-01" });
    expect(r2.complete).toBe(true);

    const entries = await loadConsignEntries(kv);
    expect(Object.keys(entries).sort()).toEqual(["c10", "c20", "c30", "c40", "c50"]);
  });
});

describe("syncConsignmentStore incremental", () => {
  it("skips an unchanged header without refetching its line items", async () => {
    const kv = createKv();
    const headersByType = {
      SUPPLIER: [header("c1", "SUPPLIER", 10, "2026-01-15")],
      RETURN: [],
    };
    const itemsById = { c1: [lineItem("p1", 5, 3)] };
    const cold = makeLsFetch(headersByType, itemsById);
    await syncConsignmentStore(kv, cold, { reset: true, dateFrom: "2025-01-01" });

    // Incremental pass: same header, same version -> no line-item call.
    const inc = makeLsFetch(headersByType, itemsById);
    await syncConsignmentStore(kv, inc, {});

    const itemCalls = inc.mock.calls.filter(([p]) => p.includes("/products"));
    expect(itemCalls.length).toBe(0);
    expect((await loadConsignEntries(kv)).c1.perPid.p1.qtyOrdered).toBe(5);
  });

  it("removes a voided consignment from the store", async () => {
    const kv = createKv();
    await syncConsignmentStore(
      kv,
      makeLsFetch(
        { SUPPLIER: [header("c1", "SUPPLIER", 10, "2026-01-15")], RETURN: [] },
        { c1: [lineItem("p1", 5)] }
      ),
      { reset: true, dateFrom: "2025-01-01" }
    );
    expect((await loadConsignEntries(kv)).c1).toBeDefined();

    // Incremental pages headers with after=<cursor>; serve the now-voided header
    // once on the SUPPLIER query, then drain.
    let served = false;
    const voided = jest.fn(async (path) => {
      if (path.includes("/products")) return { data: [] };
      if (path.includes("type=SUPPLIER") && !served) {
        served = true;
        return { data: [header("c1", "SUPPLIER", 11, "2026-01-15", { status: "VOIDED" })] };
      }
      return { data: [] };
    });
    await syncConsignmentStore(kv, voided, {});
    expect((await loadConsignEntries(kv)).c1).toBeUndefined();
  });
});

describe("seasonConsignmentBuckets", () => {
  const range = seasonScanDateRange("spring26"); // ~2024-09 .. 2026-07
  const entries = {
    c1: {
      id: "c1",
      type: "SUPPLIER",
      date: "2026-01-15",
      perPid: {
        p1: { qtyOrdered: 5, qtyReceived: 3, qtyReturned: 0 },
        pX: { qtyOrdered: 9, qtyReceived: 9, qtyReturned: 0 },
      },
    },
    c2: {
      id: "c2",
      type: "RETURN",
      date: "2026-03-01",
      perPid: { p1: { qtyOrdered: 0, qtyReceived: 0, qtyReturned: 2 } },
    },
    c3: {
      // RETURN outside the season scan range -> excluded.
      id: "c3",
      type: "RETURN",
      date: "2030-01-01",
      perPid: { p1: { qtyOrdered: 0, qtyReceived: 0, qtyReturned: 7 } },
    },
  };

  it("filters by season pid set, applies RETURN date range, and tracks salesFloorDate", () => {
    const buckets = seasonConsignmentBuckets(entries, {
      seasons: ["spring26"],
      seasonPidSets: { spring26: new Set(["p1"]) }, // pX not in season
      scanRanges: { spring26: range },
    });
    const b = buckets.spring26;
    expect(b.pidToQtyOrdered).toEqual({ p1: 5 });
    expect(b.pidToQtyReceived).toEqual({ p1: 3 });
    // c2 in range counts; c3 out of range excluded.
    expect(b.pidToQtyReturned).toEqual({ p1: 2 });
    // pX is filtered out (not in the season pid set).
    expect(b.pidToQtyOrdered.pX).toBeUndefined();
    expect(b.salesFloorDate).toBe("2026-01-15");
  });
});

describe("writeSeasonConsignBuckets", () => {
  it("persists a per-season bucket with 180d TTL", async () => {
    const kv = createKv();
    await syncConsignmentStore(
      kv,
      makeLsFetch(
        { SUPPLIER: [header("c1", "SUPPLIER", 10, "2026-01-15")], RETURN: [] },
        { c1: [lineItem("p1", 5, 3)] }
      ),
      { reset: true, dateFrom: "2025-01-01" }
    );

    await writeSeasonConsignBuckets(kv, ["spring26"], {
      seasonPidSets: { spring26: new Set(["p1"]) },
      scanRanges: { spring26: seasonScanDateRange("spring26") },
    });

    const bucket = kv.values.get(consignSeasonKey("spring26"));
    expect(bucket.pidToQtyOrdered).toEqual({ p1: 5 });
    const setCall = kv.calls.set.find((c) => c.key === consignSeasonKey("spring26"));
    expect(setCall.options).toEqual({ ex: 180 * 24 * 3600 });
  });
});
