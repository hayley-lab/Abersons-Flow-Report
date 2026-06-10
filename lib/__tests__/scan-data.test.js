import { mergeOverride } from "../override-merge";

describe("mergeOverride", () => {
  const baseData = {
    ts: 1,
    summaryRows: [{ id: "dept-1", name: "Dresses", ordered: 100, received: 80, sold: 20 }],
    deptVendors: {
      "dept-1": [
        {
          id: "supplier-1",
          name: "Shared Supplier",
          ordered: 100,
          received: 80,
          returned: 40,
          returnedCost: 10,
          sold: 20,
        },
      ],
    },
    skuToPid: { "brand/s2601": "p1" },
    productStats: {
      p1: { qtyOrdered: 1, qtyReceived: 1, retQty: 1, retVal: 40, retCost: 10 },
    },
    pidToPrice: { p1: 40 },
  };

  it("uses SKU-attributed returns instead of adding them to the LS vendor return", () => {
    const merged = mergeOverride(baseData, {
      stores: {
        "dept-1": { id: "dept-1", name: "Dresses", ordered: 100, received: 80, sold: 0 },
      },
      vendors: {
        vendor: {
          vendorId: "vendor-1",
          vendorName: "Shared Supplier",
          deptId: "dept-1",
          deptName: "Dresses",
          ordered: 100,
          received: 80,
          sold: 0,
          products: [{ style: "brand/s2601", price: 40 }],
        },
      },
    });

    expect(merged.deptVendors["dept-1"][0]).toMatchObject({
      returned: 40,
      returnedCost: 10,
    });
    expect(merged.summaryRows[0].returned).toBe(40);
  });

  it("guards ordered and received dollars from exact SKU overlap double-counting", () => {
    const merged = mergeOverride(baseData, {
      stores: {
        "dept-1": { id: "dept-1", name: "Dresses", ordered: 100, received: 80, sold: 0 },
      },
      vendors: {
        vendor: {
          vendorId: "vendor-1",
          vendorName: "Shared Supplier",
          deptId: "dept-1",
          deptName: "Dresses",
          ordered: 90,
          received: 70,
          sold: 0,
          products: [{ style: "brand/s2601", price: 40 }],
        },
      },
    });

    expect(merged.deptVendors["dept-1"][0].ordered).toBe(100);
    expect(merged.deptVendors["dept-1"][0].received).toBe(80);
  });
});
