import {
  addContribution,
  applySalesTotals,
  consignmentDate,
  dateMinusDays,
  derivedOnHand,
  emptyProductStats,
  netOrderedValue,
  netReceivedValue,
  onOrderQty,
  productCost,
  productName,
  productPrice,
  productVariant,
  saleContribution,
  seasonSalesFallbackDate,
  seasonSkuCodes,
  skuMatchesSeason,
} from "../flow-math";

describe("season SKU matching", () => {
  it("groups 2026 pre-season codes into the main spring and fall seasons", () => {
    expect(seasonSkuCodes("spring26")).toEqual(["/s26", "/rs26", "/ps26"]);
    expect(seasonSkuCodes("fall26")).toEqual(["/f26", "/pf26"]);

    expect(skuMatchesSeason("sphoenix/rs260101", "spring26")).toBe(true);
    expect(skuMatchesSeason("stokyo/pf261", "fall26")).toBe(true);
    expect(skuMatchesSeason("stokyo/pf261", "spring26")).toBe(false);
  });

  it("splits 2027 pre-seasons from the main seasons", () => {
    expect(seasonSkuCodes("spring27")).toEqual(["/s27"]);
    expect(seasonSkuCodes("prespring27")).toEqual(["/rs27", "/ps27"]);
    expect(seasonSkuCodes("fall27")).toEqual(["/f27"]);
    expect(seasonSkuCodes("prefall27")).toEqual(["/pf27"]);
  });

  it("rejects invalid season ids and blank SKUs", () => {
    expect(seasonSkuCodes("winter26")).toEqual([]);
    expect(skuMatchesSeason("", "spring26")).toBe(false);
    expect(skuMatchesSeason("abc/s2601", "winter26")).toBe(false);
  });
});

describe("saleContribution", () => {
  const seasonPidSet = new Set(["p1", "p2", "p3"]);
  const pidToPrice = { p1: 100, p2: 100, p3: 80 };

  it("puts full-price sales in sold only", () => {
    const contribution = saleContribution(
      {
        id: "sale-1",
        status: "CLOSED",
        line_items: [{ product_id: "p1", quantity: 2, total_price: "200" }],
      },
      seasonPidSet,
      pidToPrice
    );

    expect(contribution.perPid.p1).toEqual({
      sold: 2,
      onSale: 0,
      saleAmt: 0,
      soldAmt: 200,
      returned: 0,
    });
  });

  it("puts discounted and zero-dollar sales in onSale only with actual sale dollars", () => {
    const contribution = saleContribution(
      {
        id: "sale-2",
        status: "CLOSED",
        line_items: [
          { product_id: "p1", quantity: 1, total_price: "50", discount: "50" },
          { product_id: "p2", quantity: 1, total_price: "0" },
        ],
      },
      seasonPidSet,
      pidToPrice
    );

    expect(contribution.perPid.p1).toMatchObject({
      sold: 0,
      onSale: 1,
      saleAmt: 50,
      soldAmt: 50,
    });
    expect(contribution.perPid.p2).toMatchObject({
      sold: 0,
      onSale: 1,
      saleAmt: 0,
      soldAmt: 0,
    });
  });

  it("subtracts customer returns from the original sale bucket", () => {
    const contribution = saleContribution(
      {
        id: "sale-3",
        status: "CLOSED",
        line_items: [
          { product_id: "p1", quantity: -1, total_price: "-100" },
          { product_id: "p2", quantity: -1, total_price: "-50", discount_total: "50" },
        ],
      },
      seasonPidSet,
      pidToPrice
    );

    expect(contribution.perPid.p1).toMatchObject({
      sold: -1,
      onSale: 0,
      soldAmt: -100,
      returned: 1,
    });
    expect(contribution.perPid.p2).toMatchObject({
      sold: 0,
      onSale: -1,
      soldAmt: -50,
      returned: 1,
    });
  });

  it("skips open sales, voided lines, zero quantities, and non-season products", () => {
    expect(
      saleContribution(
        {
          id: "open-sale",
          status: "OPEN",
          line_items: [{ product_id: "p1", quantity: 1, total_price: "100" }],
        },
        seasonPidSet,
        pidToPrice
      ).perPid
    ).toEqual({});

    const contribution = saleContribution(
      {
        id: "sale-4",
        status: "CLOSED",
        line_items: [
          { product_id: "p1", status: "VOIDED", quantity: 1, total_price: "100" },
          { product_id: "p2", quantity: 0, total_price: "0" },
          { product_id: "not-season", quantity: 1, total_price: "100" },
        ],
      },
      seasonPidSet,
      pidToPrice
    );

    expect(contribution.perPid).toEqual({});
  });
});

describe("contribution totals", () => {
  it("adds and reverses per-product sales contributions", () => {
    const totals = {};
    const contribution = {
      perPid: {
        p1: { sold: 2, onSale: 1, saleAmt: 50, soldAmt: 250, returned: 0 },
      },
    };

    addContribution(totals, contribution);
    expect(totals.p1).toEqual({
      sold: 2,
      onSale: 1,
      saleAmt: 50,
      soldAmt: 250,
      returned: 0,
    });

    addContribution(totals, contribution, -1);
    expect(totals.p1).toEqual({
      sold: 0,
      onSale: 0,
      saleAmt: 0,
      soldAmt: 0,
      returned: 0,
    });
  });

  it("applies sales totals and clamps negative display quantities", () => {
    const productStats = {};
    applySalesTotals(productStats, {
      p1: { sold: -2, onSale: -1, saleAmt: -20, soldAmt: -120, returned: -1 },
    });

    expect(productStats.p1).toMatchObject({
      ...emptyProductStats(),
      sold: 0,
      onSale: 0,
      saleAmt: -20,
      soldAmt: -120,
      returned: 0,
    });
  });
});

describe("product-level flow math", () => {
  it("derives on-hand, on-order, and net values with zero floors", () => {
    const ps = { qtyReceived: 8, sold: 2, onSale: 1, retQty: 2, qtyOrdered: 10 };

    expect(derivedOnHand(ps)).toBe(3);
    expect(onOrderQty(ps)).toBe(2);
    expect(netOrderedValue(ps, 100)).toBe(800);
    expect(netReceivedValue(ps, 100)).toBe(600);

    expect(derivedOnHand({ qtyReceived: 1, sold: 2 })).toBe(0);
    expect(onOrderQty({ qtyOrdered: 1, qtyReceived: 3 })).toBe(0);
    expect(netOrderedValue({ qtyOrdered: 1, retQty: 3 }, 100)).toBe(0);
    expect(netReceivedValue({ qtyReceived: 1, retQty: 3 }, 100)).toBe(0);
  });
});

describe("date and product helpers", () => {
  it("computes fallback sales dates and date offsets", () => {
    expect(seasonSalesFallbackDate("spring26")).toBe("2025-02-01");
    expect(seasonSalesFallbackDate("fall26")).toBe("2025-08-01");
    expect(seasonSalesFallbackDate("bad")).toBeNull();
    expect(dateMinusDays("2026-03-10", 7)).toBe("2026-03-03");
    expect(dateMinusDays("bad-date", 7)).toBeNull();
  });

  it("normalizes consignment dates and product display fields", () => {
    expect(consignmentDate({ received_at: "2026-06-10T15:30:00Z" })).toBe("2026-06-10");
    expect(consignmentDate({ due_at: "not-a-date" })).toBeNull();

    expect(productPrice({ price_excluding_tax: "120.50" })).toBe(120.5);
    expect(productPrice({ retail_price: "88" })).toBe(88);
    expect(productCost({ supply_price: "40.25" })).toBe(40.25);
    expect(productCost({ unit_cost: "33" })).toBe(33);
    expect(productName({ description: "<p>Silk Dress</p>", name: "Fallback" })).toBe("Silk Dress");
    expect(productName({ name: "Fallback" })).toBe("Fallback");
    expect(productVariant({ variant_option_one_value: "Blue / Small" })).toBe("Blue / Small");
    expect(productVariant({ color: "Red", fabric: "Cotton", size: "M" })).toBe("Red / Cotton / M");
  });
});
