import { buildProductBuckets, displayFlowQty } from "../product-display";

describe("displayFlowQty", () => {
  it("shows negative quantities instead of hiding them", () => {
    expect(displayFlowQty(-1)).toBe(-1);
    expect(displayFlowQty(1)).toBe(1);
    expect(displayFlowQty(0)).toBe("");
  });
});

describe("buildProductBuckets", () => {
  it("nets customer returns into sold dollars like the header", () => {
    const buckets = buildProductBuckets([
      { price: 100, sold: 2 },
      { price: 450, sold: -1 },
    ]);

    expect(buckets.sold).toEqual({ n: 1, v: -250 });
  });

  it("uses actual discounted dollars, including a 100%-off sale", () => {
    const buckets = buildProductBuckets([
      { price: 100, onSale: 1, saleAmt: 0 },
      { price: 100, onSale: 2, saleAmt: 75 },
    ]);

    expect(buckets.sale).toEqual({ n: 2, v: 75 });
  });

  it("keeps returned retail aligned with the returned header fallback", () => {
    const buckets = buildProductBuckets([
      { price: 100, retQty: 2, retVal: 150 },
      { price: 50, retQty: 1, retVal: 0 },
    ]);

    expect(buckets.returned).toEqual({ n: 2, v: 200 });
  });
});
