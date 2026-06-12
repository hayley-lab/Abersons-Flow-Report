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
    expect(summaryRows.find((r) => r.id === "alley").received).toBe(145);
    expect(summaryRows.find((r) => r.id === "alley").ordered).toBe(290);
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

  it("takes the max when the same PO exists in both sources (overlap)", () => {
    // LS PO qty > 0 → overlap → ordered = max(LS, datatail), not the sum.
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
    expect(v.ordered).toBe(300); // max(LS 3*100, datatail 250) — not 550
    expect(v.received).toBe(300); // (onHand 1 + sold 2) * 100
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
