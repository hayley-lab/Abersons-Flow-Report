import {
  buildAllRows,
  rollup,
  rowsForVendor,
  vendorHeaderTotals,
  vendorRollupTotals,
} from "../flow-rollup";

// Helper: minimal scanData blob like scan:data:{season}.
function makeScanData(overrides = {}) {
  return {
    ts: 1,
    season: "spring26",
    summaryRows: [{ id: "alley", name: "Alley" }],
    seasonPids: [],
    productStats: {},
    pidToType: {},
    pidToSupplier: {},
    pidToQtyOrdered: {},
    pidToQtyReceived: {},
    pidToQtyReturned: {},
    skuToPid: {},
    pidToPrice: {},
    pidToCost: {},
    pidToName: {},
    pidToSku: {},
    pidToVariant: {},
    ...overrides,
  };
}

const vendorRow = (deptVendors, deptId, name) =>
  (deptVendors[deptId] || []).find((v) => v.name === name);

describe("rollup — consignment/datatail vendor (Allude-like)", () => {
  // Allude: products live in LS as on-hand/sold with NO LS purchase order; the
  // datatail import carries ordered as a vendor-level dollar total. Received must
  // come from LS live inventory only (never doubled by the datatail import),
  // while ordered comes from the datatail vendor-level figure.
  const scanData = makeScanData({
    seasonPids: ["p1"],
    productStats: {
      p1: { qtyOrdered: 0, qtyReceived: 0, retQty: 0, sold: 0, onSale: 0, liveOnHand: 1 },
    },
    pidToType: { p1: "alley" },
    pidToSupplier: { p1: { id: "198", name: "Allude" } },
    pidToPrice: { p1: 145 },
    pidToCost: { p1: 57 },
    pidToSku: { p1: "a82003/s260201" },
    pidToName: { p1: "linen v neck" },
    skuToPid: { "a82003/s260201": "p1" },
  });
  const override = {
    stores: { alley: { id: "alley", name: "Alley", ordered: 290, received: 145, sold: 0 } },
    vendors: {
      allude: {
        vendorId: "198",
        vendorName: "Allude",
        deptName: "Alley",
        ordered: 290, // vendor-level datatail ordered
        products: [{ style: "a82003/s260201", price: 145, cost: 57, qtyOrdered: 2, qtyStock: 1 }],
      },
    },
  };

  it("received is LS-live only (NOT doubled by datatail)", () => {
    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    expect(vendorRow(deptVendors, "alley", "Allude").received).toBe(145); // not 290
  });

  it("ordered comes from the datatail vendor-level total (LS PO is 0)", () => {
    const { deptVendors, summaryRows } = rollup(
      buildAllRows(scanData, override),
      scanData,
      override
    );
    expect(vendorRow(deptVendors, "alley", "Allude").ordered).toBe(290); // 0 LS + 290 datatail
    expect(vendorRow(deptVendors, "alley", "Allude").orderedCost).toBe(114); // 2 × $57
    expect(summaryRows.find((r) => r.id === "alley").received).toBe(145);
    expect(summaryRows.find((r) => r.id === "alley").ordered).toBe(290);
    expect(summaryRows.find((r) => r.id === "alley").orderedCost).toBe(114);
  });
});

describe("rollup — display names", () => {
  it("decodes HTML entities in imported vendor names", () => {
    const scanData = makeScanData();
    const override = {
      stores: {},
      vendors: {
        frank: {
          vendorId: "42",
          vendorName: "Frank &amp; Eileen",
          deptName: "Alley",
          ordered: 120,
          products: [{ style: "fe/s2601", description: "shirt", price: 120, qtyOrdered: 1 }],
        },
      },
    };

    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const vendor = vendorRow(deptVendors, "alley", "Frank & Eileen");

    expect(vendor).toBeTruthy();
    expect(vendor.name).toBe("Frank & Eileen");
    expect(deptVendors.alley.some((v) => v.name === "Frank &amp; Eileen")).toBe(false);
  });
});

describe("rollup — vendor-level ordered combine rule", () => {
  it("adds datatail ordered to LS when the PO is unique to one source (no overlap)", () => {
    // Consignment: LS PO qty 0 → no overlap → ordered = 0 + datatail.
    const scanData = makeScanData({
      seasonPids: ["c"],
      productStats: { c: { qtyOrdered: 0, qtyReceived: 0, sold: 0, liveOnHand: 0 } },
      pidToType: { c: "alley" },
      pidToSupplier: { c: { id: "1", name: "Consign" } },
      pidToPrice: { c: 100 },
      pidToSku: { c: "c/s2601" },
      skuToPid: { "c/s2601": "c" },
    });
    const override = {
      stores: {},
      vendors: {
        c: {
          vendorId: "1",
          vendorName: "Consign",
          deptName: "Alley",
          ordered: 500,
          products: [{ style: "c/s2601", price: 100, qtyOrdered: 0 }],
        },
      },
    };
    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    expect(vendorRow(deptVendors, "alley", "Consign").ordered).toBe(500);
  });

  it("does not add overlapping datatail ordered dollars when the same SKU has LS activity", () => {
    // LS PO qty > 0 → overlap → ordered stays LS-only for that SKU.
    const scanData = makeScanData({
      seasonPids: ["p2"],
      productStats: {
        p2: { qtyOrdered: 3, qtyReceived: 3, retQty: 0, sold: 2, onSale: 0, liveOnHand: 1 },
      },
      pidToType: { p2: "alley" },
      pidToSupplier: { p2: { id: "5", name: "Mixed Brand" } },
      pidToPrice: { p2: 100 },
      pidToCost: { p2: 40 },
      pidToSku: { p2: "mb/s2601" },
      skuToPid: { "mb/s2601": "p2" },
    });
    const override = {
      stores: {},
      vendors: {
        mb: {
          vendorId: "5",
          vendorName: "Mixed Brand",
          deptName: "Alley",
          ordered: 250,
          products: [{ style: "mb/s2601", price: 100, qtyOrdered: 2 }],
        },
      },
    };
    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const v = vendorRow(deptVendors, "alley", "Mixed Brand");
    expect(v.ordered).toBe(300); // LS 3*100 — not 300 + overlapping datatail
    expect(v.received).toBe(300); // (onHand 1 + sold 2) * 100
  });

  it("adds datatail-only ordered dollars for a mixed LS/datatail vendor", () => {
    const scanData = makeScanData({
      seasonPids: ["ls", "overlap"],
      productStats: {
        ls: { qtyOrdered: 6, qtyReceived: 6, retQty: 0, sold: 0, onSale: 0, liveOnHand: 6 },
        overlap: { qtyOrdered: 2, qtyReceived: 2, retQty: 0, sold: 0, onSale: 0, liveOnHand: 2 },
      },
      pidToType: { ls: "alley", overlap: "alley" },
      pidToSupplier: {
        ls: { id: "M", name: "Mixed Vendor" },
        overlap: { id: "M", name: "Mixed Vendor" },
      },
      pidToPrice: { ls: 100, overlap: 100 },
      pidToSku: { ls: "mix/s2601", overlap: "mix/s2602" },
      skuToPid: { "mix/s2601": "ls", "mix/s2602": "overlap" },
    });
    const override = {
      stores: {},
      vendors: {
        mixed: {
          vendorId: "M",
          vendorName: "Mixed Vendor",
          deptName: "Alley",
          ordered: 700,
          products: [
            { style: "mix/s2602", price: 100, qtyOrdered: 2 }, // overlaps LS
            { style: "mix/s2603", price: 100, qtyOrdered: 5 }, // datatail-only
          ],
        },
      },
    };

    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const v = vendorRow(deptVendors, "alley", "Mixed Vendor");
    expect(v.ordered).toBe(1300); // LS (600 + 200 overlap) + datatail-only (500)
  });

  it("ignores overlapping RMH per-product ordered but keeps RMH-only SKUs", () => {
    const scanData = makeScanData({
      seasonPids: ["overlap"],
      productStats: {
        overlap: { qtyOrdered: 2, qtyReceived: 2, retQty: 0, sold: 0, onSale: 0, liveOnHand: 2 },
      },
      pidToType: { overlap: "alley" },
      pidToSupplier: { overlap: { id: "X", name: "Crossover Vendor" } },
      pidToPrice: { overlap: 100 },
      pidToSku: { overlap: "cross/s2601" },
      skuToPid: { "cross/s2601": "overlap" },
    });
    const override = {
      stores: {},
      vendors: {
        cross: {
          vendorId: "X",
          vendorName: "Crossover Vendor",
          deptName: "Alley",
          ordered: 9999, // ignored because the bucket has overlap + per-product ordered
          products: [
            { style: "cross/s2601", price: 100, qtyOrdered: 50 }, // overlaps LS, ignored
            { style: "cross/s2602", price: 75, qtyOrdered: 4 }, // RMH-only, kept once
          ],
        },
      },
    };

    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const v = vendorRow(deptVendors, "alley", "Crossover Vendor");
    expect(v.ordered).toBe(500); // LS overlap (2 * $100) + RMH-only (4 * $75)
  });

  it("keeps datatail ordered when the LS pid has ONLY a vendor return (no PO)", () => {
    // RMH-era product migrated to LS as a product, with a vendor RETURN entered
    // in LS but NO purchase order (qtyOrdered/qtyReceived = 0). A return does not
    // mean LS owns the ordered quantity — the order lives only in the datatail
    // hard-pull. Regression: returns must NOT flag ordered-overlap (that wrongly
    // dropped the datatail ordered, since lsOrdered is 0 for these). See spring25
    // ordered understatement found by tools/recon-accuracy.js (Jun 15).
    const scanData = makeScanData({
      seasonPids: ["r"],
      productStats: {
        r: { qtyOrdered: 0, qtyReceived: 0, retQty: 2, sold: 0, onSale: 0, liveOnHand: 0 },
      },
      pidToType: { r: "alley" },
      pidToSupplier: { r: { id: "9", name: "ReturnOnly" } },
      pidToPrice: { r: 100 },
      pidToSku: { r: "r/s2601" },
      skuToPid: { "r/s2601": "r" },
    });
    const override = {
      stores: {},
      vendors: {
        ro: {
          vendorId: "9",
          vendorName: "ReturnOnly",
          deptName: "Alley",
          ordered: 500,
          products: [{ style: "r/s2601", price: 100, qtyOrdered: 5, qtyReturned: 2 }],
        },
      },
    };
    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    // ordered = LS 0 + datatail 500 (NOT dropped to 0 by the return).
    expect(vendorRow(deptVendors, "alley", "ReturnOnly").ordered).toBe(500);
  });

  it("adds only unique datatail ordered cost for a mixed LS/datatail vendor", () => {
    const scanData = makeScanData({
      seasonPids: ["ls", "overlap"],
      productStats: {
        ls: { qtyOrdered: 6, qtyReceived: 6, retQty: 0, sold: 0, onSale: 0, liveOnHand: 6 },
        overlap: { qtyOrdered: 2, qtyReceived: 2, retQty: 0, sold: 0, onSale: 0, liveOnHand: 2 },
      },
      pidToType: { ls: "alley", overlap: "alley" },
      pidToSupplier: {
        ls: { id: "M", name: "Mixed Vendor" },
        overlap: { id: "M", name: "Mixed Vendor" },
      },
      pidToPrice: { ls: 100, overlap: 100 },
      pidToCost: { ls: 40, overlap: 40 },
      pidToSku: { ls: "mix/s2601", overlap: "mix/s2602" },
      skuToPid: { "mix/s2601": "ls", "mix/s2602": "overlap" },
    });
    const override = {
      stores: {},
      vendors: {
        mixed: {
          vendorId: "M",
          vendorName: "Mixed Vendor",
          deptName: "Alley",
          ordered: 700,
          products: [
            { style: "mix/s2602", price: 100, cost: 40, qtyOrdered: 2 }, // overlaps LS
            { style: "mix/s2603", price: 100, cost: 30, qtyOrdered: 5 }, // datatail-only
          ],
        },
      },
    };

    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const v = vendorRow(deptVendors, "alley", "Mixed Vendor");
    expect(v.ordered).toBe(1300); // LS retail + unique datatail retail
    expect(v.orderedCost).toBe(470); // LS cost (6 + 2) × $40 + unique 5 × $30
  });

  it("uses matched product row cost when the datatail product omits cost", () => {
    const scanData = makeScanData({
      seasonPids: ["c"],
      productStats: { c: { qtyOrdered: 0, qtyReceived: 0, sold: 0, liveOnHand: 2 } },
      pidToType: { c: "alley" },
      pidToSupplier: { c: { id: "1", name: "Consign" } },
      pidToPrice: { c: 100 },
      pidToCost: { c: 45 },
      pidToSku: { c: "c/s2601" },
      skuToPid: { "c/s2601": "c" },
    });
    const override = {
      stores: {},
      vendors: {
        c: {
          vendorId: "1",
          vendorName: "Consign",
          deptName: "Alley",
          ordered: 200,
          products: [{ style: "c/s2601", price: 100, qtyOrdered: 2 }],
        },
      },
    };

    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    expect(vendorRow(deptVendors, "alley", "Consign").orderedCost).toBe(90);
  });

  it("does not fabricate datatail ordered cost when no product cost is available", () => {
    const scanData = makeScanData();
    const override = {
      stores: {},
      vendors: {
        c: {
          vendorId: "1",
          vendorName: "Consign",
          deptName: "Alley",
          ordered: 200,
          products: [{ style: "c/s2601", price: 100, qtyOrdered: 2 }],
        },
      },
    };

    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const v = vendorRow(deptVendors, "alley", "Consign");
    expect(v.ordered).toBe(200);
    expect(v.orderedCost).toBe(0);
  });
});

describe("buildAllRows — dual ordered semantics for the product table", () => {
  it("keeps onOrderQty (still-on-order) separate from LS ordered qty", () => {
    const scanData = makeScanData({
      seasonPids: ["p3"],
      productStats: {
        p3: { qtyOrdered: 5, qtyReceived: 2, retQty: 0, sold: 0, onSale: 0, liveOnHand: 2 },
      },
      pidToType: { p3: "alley" },
      pidToSupplier: { p3: { id: "7", name: "Brand7" } },
      pidToPrice: { p3: 10 },
      pidToSku: { p3: "b7/s2601" },
    });
    const row = buildAllRows(scanData, null)[0];
    expect(row.lsOrderedQty).toBe(5);
    expect(row.onOrderQty).toBe(3); // 5 ordered - 2 received
    expect(vendorHeaderTotals([row]).orderedRetail).toBe(50);
  });
});

describe("rollup — datatail-only SKU with no LS product", () => {
  it("falls back to datatail stock for received and uses datatail vendor ordered", () => {
    const scanData = makeScanData(); // no LS pids
    const override = {
      stores: {},
      vendors: {
        v: {
          vendorId: "9",
          vendorName: "Old Brand",
          deptName: "Alley",
          ordered: 200,
          products: [
            { style: "old/s2601", price: 50, cost: 20, qtyOrdered: 4, qtyStock: 2, qtySold: 0 },
          ],
        },
      },
    };
    const rows = buildAllRows(scanData, override);
    const { deptVendors } = rollup(rows, scanData, override);
    const v = vendorRow(deptVendors, "alley", "Old Brand");
    expect(v.ordered).toBe(200); // datatail vendor-level
    expect(v.orderedCost).toBe(80); // datatail product qty × cost
    expect(v.received).toBe(100); // 2 stock * 50, bottom-up fallback
    expect(v.cost).toBe(40); // 2 * 20
  });
});

describe("buildAllRows — null inputs", () => {
  it("returns [] when both scanData and override are null", () => {
    expect(buildAllRows(null, null)).toEqual([]);
  });
  it("builds datatail-only rows when scanData is null", () => {
    const override = {
      stores: {},
      vendors: {
        v: {
          vendorId: "9",
          vendorName: "Brand",
          deptName: "Alley",
          ordered: 10,
          products: [{ style: "x/s2601", price: 10, qtyOrdered: 1, qtyStock: 1 }],
        },
      },
    };
    const rows = buildAllRows(null, override);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe("x/s2601");
    // rollup must not throw with null scanData.
    expect(() => rollup(rows, null, override)).not.toThrow();
  });
  it("uses the request season to gate override-only rows when scanData is null", () => {
    const override = {
      stores: {},
      vendors: {
        v: {
          vendorId: "9",
          vendorName: "Brand",
          deptName: "Alley",
          ordered: 10,
          products: [{ style: "x/f2601", price: 10, qtyOrdered: 1, qtyStock: 1 }],
        },
      },
    };
    const rows = buildAllRows(null, override, { season: "spring26" });
    expect(rows).toEqual([]);
    const { deptVendors } = rollup(rows, null, override, { season: "spring26" });
    expect(vendorRow(deptVendors, "alley", "Brand")).toBeUndefined();
  });
  it("builds LS-only rows when override is null", () => {
    const scanData = makeScanData({
      seasonPids: ["p1"],
      productStats: { p1: { qtyOrdered: 1, qtyReceived: 1, liveOnHand: 1 } },
      pidToType: { p1: "alley" },
      pidToSupplier: { p1: { i: "1", n: "LS Brand" } },
      pidToPrice: { p1: 20 },
      pidToSku: { p1: "ls/s2601" },
    });
    const rows = buildAllRows(scanData, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].vendorName).toBe("LS Brand");
    const { deptVendors } = rollup(rows, scanData, null);
    expect(vendorRow(deptVendors, "alley", "LS Brand").ordered).toBe(20); // LS-only
  });
});

describe("rollup — vendor-return SKU attribution (brands sharing one LS supplier id)", () => {
  it("splits returns onto the brand that owns each SKU", () => {
    // Two brands carry the SAME LS supplier id 'S' but distinct datatail names;
    // the scan writes the per-pid brand into pidToSupplier, so grouping by name
    // attributes each return correctly.
    const scanData = makeScanData({
      seasonPids: ["r1", "r2"],
      productStats: {
        r1: { qtyOrdered: 1, qtyReceived: 1, retQty: 1, retVal: 40, sold: 0, liveOnHand: 0 },
        r2: { qtyOrdered: 2, qtyReceived: 2, retQty: 2, retVal: 60, sold: 0, liveOnHand: 0 },
      },
      pidToType: { r1: "alley", r2: "alley" },
      pidToSupplier: {
        r1: { id: "S", name: "Judi Powers" },
        r2: { id: "S", name: "Judi Powers Consignment" },
      },
      pidToPrice: { r1: 40, r2: 30 },
      pidToSku: { r1: "jp/s2601", r2: "jpc/s2601" },
    });
    const { deptVendors } = rollup(buildAllRows(scanData, null), scanData, null);
    expect(deptVendors.alley).toHaveLength(2);
    expect(vendorRow(deptVendors, "alley", "Judi Powers").returned).toBe(40);
    expect(vendorRow(deptVendors, "alley", "Judi Powers Consignment").returned).toBe(60);
  });
});

describe("returned retail/cost — datatail price fallback for zero-price LS rows", () => {
  // LS-matched vendor return where the catalog never returned a price
  // (pidToPrice 0, retVal 0). The datatail import carries the price, so the
  // Returned (retail/cost) columns must fall back to it instead of showing $0.
  const scanData = makeScanData({
    seasonPids: ["p1"],
    productStats: {
      p1: {
        qtyOrdered: 2,
        qtyReceived: 2,
        retQty: 2,
        retVal: 0,
        retCost: 0,
        sold: 0,
        liveOnHand: 0,
      },
    },
    pidToType: { p1: "alley" },
    pidToSupplier: { p1: { id: "Z", name: "ZeroPrice Brand" } },
    pidToPrice: { p1: 0 }, // catalog price missing → the bug
    pidToCost: { p1: 0 },
    pidToSku: { p1: "ret/s2601" },
    skuToPid: { "ret/s2601": "p1" },
  });
  const override = {
    stores: {},
    vendors: {
      z: {
        vendorId: "Z",
        vendorName: "ZeroPrice Brand",
        deptName: "Alley",
        ordered: 0,
        products: [{ style: "ret/s2601", price: 100, cost: 40, qtyReturned: 2 }],
      },
    },
  };

  it("uses datatail op.price for Returned (retail) when catalog price is $0", () => {
    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const v = vendorRow(deptVendors, "alley", "ZeroPrice Brand");
    expect(v.returned).toBe(200); // 2 × $100 (was $0 before the fallback)
  });

  it("uses datatail op.cost for Returned (cost) when catalog cost is $0", () => {
    const { deptVendors } = rollup(buildAllRows(scanData, override), scanData, override);
    const v = vendorRow(deptVendors, "alley", "ZeroPrice Brand");
    expect(v.returnedCost).toBe(80); // 2 × $40
  });
});

describe("RMH returns injected onto matched LS pid (4e — returns not in LS)", () => {
  // An LS-matched product that LS shows as 0 returned (the RMH-era vendor return
  // never reached LS). The hard-pull/backfill override carries qtyReturned, which
  // must surface in the Returned column and net Received down.
  const baseScan = () =>
    makeScanData({
      seasonPids: ["p1"],
      productStats: {
        p1: { qtyOrdered: 5, qtyReceived: 5, retQty: 0, retVal: 0, sold: 0, liveOnHand: 3 },
      },
      pidToType: { p1: "alley" },
      pidToSupplier: { p1: { id: "S", name: "Staud" } },
      pidToPrice: { p1: 100 },
      pidToCost: { p1: 40 },
      pidToSku: { p1: "cn2102po/s260101" },
      skuToPid: { "cn2102po/s260101": "p1" },
    });
  const rmhReturnOverride = {
    stores: {},
    vendors: {
      rmhret__S: {
        vendorId: "S",
        vendorName: "Staud",
        deptName: "Alley",
        ordered: 0,
        products: [
          { style: "cn2102po/s260101", price: 100, cost: 40, qtyReturned: 2, qtyOrdered: 0 },
        ],
      },
    },
  };

  it("surfaces the RMH return in the Returned column when LS has none", () => {
    const scanData = baseScan();
    const rows = buildAllRows(scanData, rmhReturnOverride, { season: "spring26" });
    expect(rows[0].retQty).toBe(2);
    const { deptVendors } = rollup(rows, scanData, rmhReturnOverride, { season: "spring26" });
    const v = vendorRow(deptVendors, "alley", "Staud");
    expect(v.returned).toBe(200); // 2 × $100
    expect(v.returnedCost).toBe(80); // 2 × $40
    expect(v.received).toBe(300); // (5 received − 2 returned) × $100
  });

  it("does NOT add the override return when LS already records a return (no double count)", () => {
    const scanData = baseScan();
    scanData.productStats.p1.retQty = 2; // LS already has the return
    const rows = buildAllRows(scanData, rmhReturnOverride, { season: "spring26" });
    expect(rows[0].retQty).toBe(2); // LS value wins, not 2 + 2
    const { deptVendors } = rollup(rows, scanData, rmhReturnOverride, { season: "spring26" });
    const v = vendorRow(deptVendors, "alley", "Staud");
    expect(v.returned).toBe(200); // still just 2 × $100
  });

  it("takes the MAX per pid across override records (shared RMH source)", () => {
    const scanData = baseScan();
    const override = {
      stores: {},
      vendors: {
        a: {
          vendorName: "Staud",
          deptName: "Alley",
          products: [{ style: "cn2102po/s260101", price: 100, cost: 40, qtyReturned: 2 }],
        },
        b: {
          vendorName: "Staud",
          deptName: "Alley",
          products: [{ style: "cn2102po/s260101", price: 100, cost: 40, qtyReturned: 2 }],
        },
      },
    };
    const rows = buildAllRows(scanData, override, { season: "spring26" });
    expect(rows[0].retQty).toBe(2); // max(2, 2), not summed to 4
  });

  it("shows the deduped UNION: LS-era return on one pid + RMH-only on another", () => {
    // Mirrors the live spring26 finding (Jun 15): LS captures its own returns
    // (type=RETURN) AND the override carries RMH-only returns. The report must be
    // the union — LS value wins where both exist (overlap), RMH-only surfaces
    // where LS has none — never RMH-POType3-alone and never double-counted.
    const scanData = makeScanData({
      seasonPids: ["pOverlap", "pLsOnly", "pRmhOnly"],
      productStats: {
        pOverlap: { qtyOrdered: 4, qtyReceived: 4, retQty: 2, sold: 0, liveOnHand: 2 }, // LS return
        pLsOnly: { qtyOrdered: 3, qtyReceived: 3, retQty: 1, sold: 0, liveOnHand: 2 }, // LS-only return
        pRmhOnly: { qtyOrdered: 5, qtyReceived: 5, retQty: 0, sold: 0, liveOnHand: 5 }, // LS has none
      },
      pidToType: { pOverlap: "alley", pLsOnly: "alley", pRmhOnly: "alley" },
      pidToSupplier: {
        pOverlap: { id: "S", name: "Staud" },
        pLsOnly: { id: "S", name: "Staud" },
        pRmhOnly: { id: "S", name: "Staud" },
      },
      pidToPrice: { pOverlap: 100, pLsOnly: 100, pRmhOnly: 100 },
      pidToCost: { pOverlap: 40, pLsOnly: 40, pRmhOnly: 40 },
      pidToSku: {
        pOverlap: "a/s2601",
        pLsOnly: "b/s2601",
        pRmhOnly: "c/s2601",
      },
      skuToPid: { "a/s2601": "pOverlap", "b/s2601": "pLsOnly", "c/s2601": "pRmhOnly" },
    });
    const override = {
      stores: {},
      vendors: {
        rmhret__S: {
          vendorId: "S",
          vendorName: "Staud",
          deptName: "Alley",
          ordered: 0,
          products: [
            { style: "a/s2601", price: 100, cost: 40, qtyReturned: 2, qtyOrdered: 0 }, // overlaps LS
            { style: "c/s2601", price: 100, cost: 40, qtyReturned: 3, qtyOrdered: 0 }, // RMH-only
          ],
        },
      },
    };
    const rows = buildAllRows(scanData, override, { season: "spring26" });
    const ret = (sku) => rows.find((r) => r.sku === sku).retQty;
    expect(ret("a/s2601")).toBe(2); // overlap: LS wins (not 2+2)
    expect(ret("b/s2601")).toBe(1); // LS-only return preserved
    expect(ret("c/s2601")).toBe(3); // RMH-only surfaced from override
    // Union total = 2 (overlap, deduped) + 1 (LS-only) + 3 (RMH-only) = 6,
    // NOT RMH-POType3-alone (2+3=5) and NOT double-counted (2+2+1+3=8).
    const total = rows.reduce((a, r) => a + (r.retQty || 0), 0);
    expect(total).toBe(6);
  });
});

describe("RMH sold/on-sale overlay for closed seasons", () => {
  it("uses RMH net sold/on-sale for an LS-matched pid when RMH is richer", () => {
    const scanData = makeScanData({
      season: "spring25",
      seasonPids: ["p1"],
      productStats: {
        p1: { qtyOrdered: 0, qtyReceived: 0, retQty: 0, sold: 1, onSale: 0, liveOnHand: 0 },
      },
      pidToType: { p1: "alley" },
      pidToSupplier: { p1: { id: "S", name: "Staud" } },
      pidToPrice: { p1: 100 },
      pidToSku: { p1: "staud/s2501" },
      skuToPid: { "staud/s2501": "p1" },
    });
    const override = {
      stores: {},
      vendors: {
        rmhsold__S: {
          vendorId: "S",
          vendorName: "Staud",
          deptName: "Alley",
          source: "rmh-sold-backfill",
          products: [
            { style: "staud/s2501", price: 100, qtySold: 2, qtySale: 1, saleAmt: 45 },
            { style: "staud/f2501", price: 100, qtySold: 99, qtySale: 0, saleAmt: 0 },
          ],
        },
      },
    };

    const rows = buildAllRows(scanData, override, { season: "spring25" });
    expect(rows).toHaveLength(1);
    expect(rows[0].sold).toBe(2);
    expect(rows[0].onSale).toBe(1);
    expect(rows[0].saleAmt).toBe(45);
    // The overlaid fields are tagged so the LS-only validation harness knows
    // they are not LS-verifiable and skips them instead of flagging drift.
    expect(rows[0].overrideFields).toEqual(["sold", "onSale", "saleAmt"]);

    const { deptVendors } = rollup(rows, scanData, override, { season: "spring25" });
    expect(vendorRow(deptVendors, "alley", "Staud").sold).toBe(200);
  });

  it("keeps LS sales when LS has more net units than RMH", () => {
    const scanData = makeScanData({
      season: "spring25",
      seasonPids: ["p1"],
      productStats: {
        p1: {
          qtyOrdered: 0,
          qtyReceived: 0,
          retQty: 0,
          sold: 4,
          onSale: 2,
          saleAmt: 80,
          liveOnHand: 0,
        },
      },
      pidToType: { p1: "alley" },
      pidToSupplier: { p1: { id: "S", name: "Staud" } },
      pidToPrice: { p1: 100 },
      pidToSku: { p1: "staud/s2501" },
      skuToPid: { "staud/s2501": "p1" },
    });
    const override = {
      stores: {},
      vendors: {
        rmhsold__S: {
          vendorId: "S",
          vendorName: "Staud",
          deptName: "Alley",
          source: "rmh-sold-backfill",
          products: [{ style: "staud/s2501", price: 100, qtySold: 3, qtySale: 2, saleAmt: 60 }],
        },
      },
    };

    const row = buildAllRows(scanData, override, { season: "spring25" })[0];
    expect(row.sold).toBe(4);
    expect(row.onSale).toBe(2);
    expect(row.saleAmt).toBe(80);
    // LS won, so nothing is override-sourced and the field stays LS-verifiable.
    expect(row.overrideFields).toBeUndefined();
  });

  it("applies the same whole-source overlay to datatail-only rows without duplicates", () => {
    const scanData = makeScanData({ season: "spring25" });
    const override = {
      stores: {},
      vendors: {
        original: {
          vendorId: "O",
          vendorName: "Old Brand",
          deptName: "Alley",
          ordered: 100,
          products: [{ style: "old/s2501", price: 50, qtySold: 0, qtySale: 0 }],
        },
        rmhsold__O: {
          vendorId: "O",
          vendorName: "Old Brand",
          deptName: "Alley",
          source: "rmh-sold-backfill",
          products: [{ style: "old/s2501", price: 50, qtySold: 3, qtySale: 1, saleAmt: 25 }],
        },
      },
    };

    const rows = buildAllRows(scanData, override, { season: "spring25" });
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBe("old/s2501");
    expect(rows[0].sold).toBe(3);
    expect(rows[0].onSale).toBe(1);
    expect(rows[0].saleAmt).toBe(25);
  });
});

describe("override season gate — wrong-season import cannot pollute", () => {
  it("drops override products whose SKU belongs to another season", () => {
    const scanData = makeScanData({ season: "spring26" }); // no LS pids
    const override = {
      stores: {},
      vendors: {
        wrong: {
          vendorId: "W",
          vendorName: "Wrong Season",
          deptName: "Alley",
          ordered: 999,
          products: [{ style: "x/f2601", price: 50, qtyOrdered: 3, qtyStock: 3 }], // fall SKU
        },
      },
    };
    const rows = buildAllRows(scanData, override);
    expect(rows).toHaveLength(0); // fall SKU gated out of spring26
    const { deptVendors } = rollup(rows, scanData, override);
    const v = vendorRow(deptVendors, "alley", "Wrong Season");
    expect(v).toBeUndefined(); // no ordered dollars folded in either
  });

  it("keeps override products whose SKU folds into this season (rs→spring)", () => {
    const scanData = makeScanData({ season: "spring26" });
    const override = {
      stores: {},
      vendors: {
        ok: {
          vendorId: "O",
          vendorName: "Right Season",
          deptName: "Alley",
          ordered: 200,
          products: [{ style: "y/rs2601", price: 50, qtyOrdered: 4, qtyStock: 2 }], // pre-spring folds in
        },
      },
    };
    const rows = buildAllRows(scanData, override);
    expect(rows).toHaveLength(1);
    const { deptVendors } = rollup(rows, scanData, override);
    expect(vendorRow(deptVendors, "alley", "Right Season").ordered).toBe(200);
  });
});

describe("vendorRollupTotals — dept-scoped __none__ rows", () => {
  it("matches visible vendor rows when the dept view also shows Other rows", () => {
    const scanData = makeScanData({
      seasonPids: ["dept", "none"],
      productStats: {
        dept: { qtyOrdered: 1, qtyReceived: 1, retQty: 0, sold: 1, onSale: 0, liveOnHand: 0 },
        none: { qtyOrdered: 2, qtyReceived: 2, retQty: 0, sold: 0, onSale: 0, liveOnHand: 2 },
      },
      pidToType: { dept: "alley", none: "__none__" },
      pidToSupplier: {
        dept: { id: "V", name: "Vendor" },
        none: { id: "V", name: "Vendor" },
      },
      pidToPrice: { dept: 100, none: 50 },
      pidToCost: { dept: 40, none: 20 },
      pidToSku: { dept: "v/s2601", none: "v/s2602" },
    });
    const rows = buildAllRows(scanData, null);
    const { deptVendors } = rollup(rows, scanData, null);
    const listRow = vendorRow(deptVendors, "alley", "Vendor");
    const visibleRows = rowsForVendor(rows, listRow, { id: "alley" });
    const rowSum = vendorHeaderTotals(visibleRows);
    const header = vendorRollupTotals(deptVendors, listRow, { id: "alley" });

    expect(visibleRows.map((r) => r.deptId).sort()).toEqual(["__none__", "alley"]);
    expect(header.receivedRetail).toBeCloseTo(rowSum.receivedRetail, 6);
    expect(header.soldRetail).toBeCloseTo(rowSum.soldRetail, 6);
    expect(header.orderedRetail).toBe(200); // alley LS ordered 100 + __none__ LS ordered 100
  });

  it("does not double-count Other rows in the all-departments view", () => {
    const deptVendors = {
      alley: [{ id: "V", name: "Vendor", ordered: 100, received: 100 }],
      __none__: [{ id: "V", name: "Vendor", ordered: 50, received: 50 }],
    };
    const header = vendorRollupTotals(deptVendors, { id: "V", name: "Vendor" }, null);
    expect(header.orderedRetail).toBe(150);
    expect(header.receivedRetail).toBe(150);
  });
});

describe("vendor drilldown bucket matching", () => {
  it("keeps shared-supplier-id brands in separate drilldown buckets", () => {
    const scanData = makeScanData({
      seasonPids: ["levi", "other"],
      productStats: {
        levi: { qtyOrdered: 1, qtyReceived: 1, retQty: 0, sold: 0, onSale: 0, liveOnHand: 1 },
        other: { qtyOrdered: 2, qtyReceived: 2, retQty: 0, sold: 0, onSale: 0, liveOnHand: 2 },
      },
      pidToType: { levi: "alley", other: "alley" },
      pidToSupplier: {
        levi: { id: "shared", name: "Levi&#039;s" },
        other: { id: "shared", name: "Other Brand" },
      },
      pidToPrice: { levi: 100, other: 50 },
      pidToCost: { levi: 40, other: 20 },
      pidToSku: { levi: "levi/s2601", other: "other/s2601" },
    });
    const rows = buildAllRows(scanData, null);
    const { deptVendors } = rollup(rows, scanData, null);
    const listRow = vendorRow(deptVendors, "alley", "Levi's");
    const visibleRows = rowsForVendor(rows, listRow, { id: "alley" });
    const rowSum = vendorHeaderTotals(visibleRows);
    const header = vendorRollupTotals(deptVendors, listRow, { id: "alley" });

    expect(visibleRows.map((r) => r.pid)).toEqual(["levi"]);
    expect(rowSum.receivedRetail).toBeCloseTo(listRow.received, 6);
    expect(header.receivedRetail).toBeCloseTo(listRow.received, 6);
    expect(header.receivedRetail).toBe(100);
  });
});

describe("netReceivedCost — never negative for consignment", () => {
  it("floors received cost at $0 when returns exceed live receipts", () => {
    const scanData = makeScanData({
      seasonPids: ["c1"],
      productStats: {
        c1: { qtyOrdered: 1, qtyReceived: 1, retQty: 1, sold: 0, onSale: 0, liveOnHand: 0 },
      },
      pidToType: { c1: "alley" },
      pidToSupplier: { c1: { id: "C", name: "Consign" } },
      pidToPrice: { c1: 100 },
      pidToCost: { c1: 50 },
      pidToSku: { c1: "c/s2601" },
    });
    const { deptVendors } = rollup(buildAllRows(scanData, null), scanData, null);
    expect(vendorRow(deptVendors, "alley", "Consign").cost).toBe(0);
  });
});

describe("Received from PO qtyReceived + consignment fallback (Q2/Q1b)", () => {
  it("Received uses PO qtyReceived and is unaffected by a manual on-hand drop", () => {
    // PO received 4 (no vendor returns), but live on-hand was manually corrected
    // down to 1. Received must stay 4 × price (PO-based), not the live-derived 3.
    const scanData = makeScanData({
      seasonPids: ["p"],
      productStats: {
        p: { qtyOrdered: 4, qtyReceived: 4, retQty: 0, sold: 2, onSale: 0, liveOnHand: 1 },
      },
      pidToType: { p: "alley" },
      pidToSupplier: { p: { id: "1", name: "PO Brand" } },
      pidToPrice: { p: 100 },
      pidToSku: { p: "po/s2601" },
    });
    const { deptVendors } = rollup(buildAllRows(scanData, null), scanData, null);
    const v = vendorRow(deptVendors, "alley", "PO Brand");
    expect(v.received).toBe(400); // 4 received × 100, NOT (onHand 1 + sold 2) × 100 = 300
  });

  it("Received header nets vendor returns from PO qtyReceived", () => {
    const scanData = makeScanData({
      seasonPids: ["p"],
      productStats: {
        p: { qtyOrdered: 5, qtyReceived: 5, retQty: 2, sold: 0, onSale: 0, liveOnHand: 3 },
      },
      pidToType: { p: "alley" },
      pidToSupplier: { p: { id: "1", name: "Net Brand" } },
      pidToPrice: { p: 100 },
      pidToSku: { p: "net/s2601" },
    });
    const { deptVendors } = rollup(buildAllRows(scanData, null), scanData, null);
    expect(vendorRow(deptVendors, "alley", "Net Brand").received).toBe(300); // (5 − 2) × 100
  });

  it("does not flag a consignment no-PO product (qtyReceived 0) as a mismatch", () => {
    const scanData = makeScanData({
      seasonPids: ["c"],
      productStats: {
        c: { qtyOrdered: 0, qtyReceived: 0, retQty: 0, sold: 0, onSale: 0, liveOnHand: 4 },
      },
      pidToType: { c: "alley" },
      pidToSupplier: { c: { id: "1", name: "Consign" } },
      pidToPrice: { c: 100 },
      pidToSku: { c: "c/s2601" },
    });
    const rows = buildAllRows(scanData, null);
    const row = rows.find((r) => r.pid === "c");
    expect(row.inventoryMismatch).toBe(false); // would have been true under old PO math
    // Received still flows from the live-derived fallback.
    const { deptVendors } = rollup(rows, scanData, null);
    expect(vendorRow(deptVendors, "alley", "Consign").received).toBe(400); // 4 × 100
  });

  it("still flags a real manual adjustment on a PO-backed product", () => {
    const scanData = makeScanData({
      seasonPids: ["p"],
      productStats: {
        p: { qtyOrdered: 4, qtyReceived: 4, retQty: 0, sold: 0, onSale: 0, liveOnHand: 9 },
      },
      pidToType: { p: "alley" },
      pidToSupplier: { p: { id: "1", name: "PO Brand" } },
      pidToPrice: { p: 100 },
      pidToSku: { p: "po/s2601" },
    });
    const row = buildAllRows(scanData, null).find((r) => r.pid === "p");
    expect(row.inventoryMismatch).toBe(true); // derived 4 vs live 9
  });
});

describe("Layer 2 invariants (CI gate)", () => {
  // A richer multi-dept / multi-vendor fixture exercised against every rollup
  // invariant the report must always satisfy (see the assurance plan, Layer 2).
  const scanData = makeScanData({
    summaryRows: [
      { id: "alley", name: "Alley" },
      { id: "shoes", name: "Shoes" },
    ],
    seasonPids: ["p1", "p2", "p3", "p4"],
    productStats: {
      // p1: normal full-price; on-hand reconciles (recv 3 - sold 1 = onHand 2).
      p1: { qtyOrdered: 3, qtyReceived: 3, retQty: 0, sold: 1, onSale: 0, liveOnHand: 2 },
      // p2: on sale; reconciles (recv 1 - onSale 1 = 0).
      p2: { qtyOrdered: 1, qtyReceived: 1, retQty: 0, sold: 0, onSale: 1, liveOnHand: 0 },
      // p3: vendor return + a CUSTOMER return (returned:5) that must NOT appear
      // in the Returned column; on-hand manually adjusted (mismatch).
      p3: {
        qtyOrdered: 4,
        qtyReceived: 4,
        retQty: 1,
        retVal: 60,
        sold: 0,
        onSale: 0,
        returned: 5,
        liveOnHand: 7,
      },
      // p4: consignment-style, fully returned to vendor (received-cost floors $0).
      p4: { qtyOrdered: 2, qtyReceived: 2, retQty: 2, sold: 0, onSale: 0, liveOnHand: 0 },
    },
    pidToType: { p1: "alley", p2: "alley", p3: "shoes", p4: "alley" },
    pidToSupplier: {
      p1: { id: "A", name: "Allude" },
      p2: { id: "A", name: "Allude" },
      p3: { id: "B", name: "Bottega" },
      p4: { id: "C", name: "Consign" },
    },
    pidToPrice: { p1: 100, p2: 200, p3: 60, p4: 80 },
    pidToCost: { p1: 40, p2: 80, p3: 24, p4: 30 },
    pidToSku: { p1: "a/s2601", p2: "a/s2602", p3: "b/s2601", p4: "c/s2601" },
    skuToPid: { "a/s2601": "p1", "a/s2602": "p2", "b/s2601": "p3", "c/s2601": "p4" },
  });
  const override = {
    stores: {},
    vendors: {
      allude: {
        vendorId: "A",
        vendorName: "Allude",
        deptName: "Alley",
        ordered: 250,
        products: [{ style: "a/s2601", price: 100, qtyOrdered: 2 }],
      },
    },
  };

  const rows = buildAllRows(scanData, override);
  const { summaryRows, deptVendors } = rollup(rows, scanData, override);
  const FIELDS = ["ordered", "orderedCost", "received", "cost", "returned", "returnedCost", "sold"];

  it("vendor totals equal the bottom-up sum of that vendor's product rows", () => {
    for (const [deptId, vendors] of Object.entries(deptVendors)) {
      for (const v of vendors) {
        const sum = vendorHeaderTotals(rowsForVendor(rows, v, { id: deptId }));
        expect(v.received).toBeCloseTo(sum.receivedRetail, 6);
        expect(v.cost).toBeCloseTo(sum.receivedCost, 6);
        expect(v.returned).toBeCloseTo(sum.returnedRetail, 6);
        expect(v.returnedCost).toBeCloseTo(sum.returnedCost, 6);
        expect(v.sold).toBeCloseTo(sum.soldRetail, 6);
      }
    }
  });

  it("department totals equal the sum of their vendor rows (every field)", () => {
    for (const dept of summaryRows) {
      const vendors = deptVendors[dept.id] || [];
      for (const f of FIELDS) {
        const sum = vendors.reduce((a, v) => a + (v[f] || 0), 0);
        expect(dept[f] || 0).toBeCloseTo(sum, 6);
      }
    }
  });

  it("season totals equal the sum of all departments", () => {
    for (const f of FIELDS) {
      const seasonTotal = summaryRows.reduce((a, d) => a + (d[f] || 0), 0);
      const vendorTotal = Object.values(deptVendors)
        .flat()
        .reduce((a, v) => a + (v[f] || 0), 0);
      expect(seasonTotal).toBeCloseTo(vendorTotal, 6);
    }
  });

  it("Returned column reflects retQty only, never customer returns (productStats.returned)", () => {
    // p3 carries returned:5 (customer returns) but retQty:1 — Returned must be
    // 1 × $60 = $60 and never include the 5 customer returns.
    expect(vendorRow(deptVendors, "shoes", "Bottega").returned).toBe(60);
  });

  it("flags inventoryMismatch only when live on-hand diverges from the derived stock", () => {
    const byPid = Object.fromEntries(rows.filter((r) => r.pid).map((r) => [r.pid, r]));
    // p1 reconciles (recv 3 - sold 1 - 0 - 0 = 2 == liveOnHand 2).
    expect(byPid.p1.inventoryMismatch).toBe(false);
    // p3 manually adjusted (derived 3, live 7).
    expect(byPid.p3.inventoryMismatch).toBe(true);
  });

  it("never reports a negative cost header (consignment returns floor at $0)", () => {
    for (const v of Object.values(deptVendors).flat()) {
      expect(v.cost).toBeGreaterThanOrEqual(0);
      expect(v.returnedCost).toBeGreaterThanOrEqual(0);
      expect(v.orderedCost).toBeGreaterThanOrEqual(0);
    }
    // p4 received 2 then returned 2 — net received cost is floored at $0.
    expect(vendorRow(deptVendors, "alley", "Consign").cost).toBe(0);
  });

  it("bounds the datatail/LS ordered combine at the sum of the two sources", () => {
    // Allude: LS ordered = (p1 3 + p2 1, both full) × price; datatail 250.
    // overlap (p1 has LS PO qty) → ordered = max(LS, datatail) ≤ LS + datatail.
    const v = vendorRow(deptVendors, "alley", "Allude");
    const lsOrdered = 3 * 100 + 1 * 200; // 500
    expect(v.ordered).toBeLessThanOrEqual(lsOrdered + 250);
    expect(v.ordered).toBe(Math.max(lsOrdered, 250)); // 500
  });

  it("keeps each product's contribution inside its own department (season isolation)", () => {
    // p3 (shoes) must not leak into alley and vice-versa.
    expect(deptVendors.shoes.every((v) => v.name === "Bottega")).toBe(true);
    expect(deptVendors.alley.some((v) => v.name === "Bottega")).toBe(false);
  });
});

describe("cross-page consistency invariant", () => {
  // The whole point of the refactor: header == vendor list row, received/sold
  // equal the sum of the bottom-up rows, and summary == sum of its departments.
  const scanData = makeScanData({
    summaryRows: [
      { id: "alley", name: "Alley" },
      { id: "shoes", name: "Shoes" },
    ],
    seasonPids: ["p1", "p2", "p3"],
    productStats: {
      p1: { qtyOrdered: 2, qtyReceived: 2, retQty: 0, sold: 1, onSale: 0, liveOnHand: 1 },
      p2: { qtyOrdered: 0, qtyReceived: 0, retQty: 0, sold: 0, onSale: 1, liveOnHand: 0 },
      p3: { qtyOrdered: 4, qtyReceived: 3, retQty: 1, sold: 0, onSale: 0, liveOnHand: 2 },
    },
    pidToType: { p1: "alley", p2: "alley", p3: "shoes" },
    pidToSupplier: {
      p1: { id: "A", name: "Allude" },
      p2: { id: "A", name: "Allude" },
      p3: { id: "B", name: "Bottega" },
    },
    pidToPrice: { p1: 100, p2: 200, p3: 50 },
    pidToCost: { p1: 40, p2: 80, p3: 20 },
    pidToSku: { p1: "a/s2601", p2: "a/s2602", p3: "b/s2601" },
    skuToPid: { "a/s2601": "p1", "a/s2602": "p2", "b/s2601": "p3" },
  });
  const override = {
    stores: {},
    vendors: {
      allude: {
        vendorId: "A",
        vendorName: "Allude",
        deptName: "Alley",
        ordered: 250,
        products: [{ style: "a/s2601", price: 100, qtyOrdered: 2 }],
      },
    },
  };

  it("vendor header (rollup) equals the matching deptVendors list row", () => {
    const rows = buildAllRows(scanData, override);
    const { deptVendors } = rollup(rows, scanData, override);
    const listRow = vendorRow(deptVendors, "alley", "Allude");
    const header = vendorRollupTotals(deptVendors, listRow, { id: "alley" });
    expect(header.receivedRetail).toBeCloseTo(listRow.received, 6);
    expect(header.orderedRetail).toBeCloseTo(listRow.ordered, 6);
    expect(header.soldRetail).toBeCloseTo(listRow.sold, 6);
  });

  it("header received/sold equal the bottom-up sum of the product rows", () => {
    const rows = buildAllRows(scanData, override);
    const { deptVendors } = rollup(rows, scanData, override);
    const listRow = vendorRow(deptVendors, "alley", "Allude");
    const rowSum = vendorHeaderTotals(rowsForVendor(rows, listRow, { id: "alley" }));
    expect(rowSum.receivedRetail).toBeCloseTo(listRow.received, 6);
    expect(rowSum.soldRetail).toBeCloseTo(listRow.sold, 6);
  });

  it("summary department totals equal the sum of their vendor rows", () => {
    const rows = buildAllRows(scanData, override);
    const { summaryRows, deptVendors } = rollup(rows, scanData, override);
    for (const dept of summaryRows) {
      const vendors = deptVendors[dept.id] || [];
      const sum = vendors.reduce((a, v) => a + v.received, 0);
      expect(dept.received).toBeCloseTo(sum, 6);
    }
  });

  it("all-department vendor header equals the sum across that vendor's departments", () => {
    const rows = buildAllRows(scanData, override);
    const { deptVendors } = rollup(rows, scanData, override);
    const header = vendorRollupTotals(deptVendors, { id: "A", name: "Allude" }, null);
    // Allude only in Alley: p1 (onHand 1 + sold 1) * 100 + p2 (onSale 1) * 200 = 400.
    expect(header.receivedRetail).toBe(400);
  });
});
