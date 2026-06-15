import {
  addContribution,
  applySalesTotals,
  consignmentDate,
  dateInRange,
  dateMinusDays,
  derivedOnHand,
  displayOnHand,
  emptyProductStats,
  mismatchDerivedStock,
  netOrderedValue,
  netReceivedCost,
  netReceivedRetail,
  netReceivedUnits,
  netReceivedValue,
  onOrderQty,
  preferPositive,
  productCost,
  productName,
  productPrice,
  productVariant,
  returnBucketFromOriginal,
  returnForId,
  returnedCostValue,
  returnedRetailValue,
  saleContribution,
  seasonScanDateRange,
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

  it("matches only the anchored season segment after the slash", () => {
    expect(skuMatchesSeason("s26style/f2601", "spring26")).toBe(false);
    expect(skuMatchesSeason("fancy/rs2601", "spring26")).toBe(true);
    expect(skuMatchesSeason("fancy/xrs2601", "spring26")).toBe(false);
  });
});

describe("preferPositive — price/cost upgrade rule (root cause of $0 poisoning)", () => {
  it("promotes a stored $0 to a later real catalog price", () => {
    // A pid first registered at $0 (variant before parent / PO fetch w/o price)
    // must pick up the catalog price on the next registration.
    let stored = 0;
    stored = preferPositive(stored, 145);
    expect(stored).toBe(145);
  });

  it("never overwrites a real price with a later $0", () => {
    expect(preferPositive(145, 0)).toBe(145);
    expect(preferPositive(145, undefined)).toBe(145);
  });

  it("keeps the first real value when both are positive", () => {
    expect(preferPositive(120, 90)).toBe(120);
  });

  it("treats undefined/NaN/strings as zero and coerces a positive incoming", () => {
    expect(preferPositive(undefined, 50)).toBe(50);
    expect(preferPositive(NaN, 50)).toBe(50);
    expect(preferPositive("0", "57")).toBe(57);
    expect(preferPositive(0, 0)).toBe(0);
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

  it("uses the line's own original price when classifying discounts", () => {
    const contribution = saleContribution(
      {
        id: "sale-line-price",
        status: "CLOSED",
        line_items: [{ product_id: "p3", quantity: 1, total_price: "70", original_price: "100" }],
      },
      seasonPidSet,
      { p3: 70 }
    );

    expect(contribution.perPid.p3).toMatchObject({
      sold: 0,
      onSale: 1,
      saleAmt: 70,
      soldAmt: 70,
    });
  });

  it("derives a multi-qty line total from a unit price when total_price is absent", () => {
    // li.price is a UNIT price: a qty-2 line at $100/unit is a $200 full-price
    // sale, not a $100 discounted one (the old code used li.price as-is).
    const contribution = saleContribution(
      {
        id: "sale-unit-price",
        status: "CLOSED",
        line_items: [{ product_id: "p1", quantity: 2, price: "100" }],
      },
      seasonPidSet,
      pidToPrice
    );

    expect(contribution.perPid.p1).toMatchObject({
      sold: 2,
      onSale: 0,
      saleAmt: 0,
      soldAmt: 200,
    });
  });

  it("treats a sale with no price metadata and no catalog price as full price", () => {
    const contribution = saleContribution(
      {
        id: "sale-no-meta",
        status: "CLOSED",
        line_items: [{ product_id: "p9", quantity: 1, total_price: "120" }],
      },
      new Set(["p9"]),
      {} // catalog price unknown (0/stale)
    );

    expect(contribution.perPid.p9).toMatchObject({ sold: 1, onSale: 0, soldAmt: 120 });
  });

  it("classifies a 100%-off line as onSale with $0 actual dollars", () => {
    const contribution = saleContribution(
      {
        id: "sale-free",
        status: "CLOSED",
        line_items: [{ product_id: "p1", quantity: 1, total_price: "0", full_price: "100" }],
      },
      seasonPidSet,
      pidToPrice
    );

    expect(contribution.perPid.p1).toMatchObject({ sold: 0, onSale: 1, saleAmt: 0 });
  });

  it("excludes PARKED and LAYBY sales", () => {
    for (const status of ["PARKED", "LAYBY", "LAYAWAY"]) {
      expect(
        saleContribution(
          {
            id: `${status}-sale`,
            status,
            line_items: [{ product_id: "p1", quantity: 1, total_price: "100" }],
          },
          seasonPidSet,
          pidToPrice
        ).perPid
      ).toEqual({});
    }
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
      saleAmt: -50,
      soldAmt: -50,
      returned: 1,
    });
  });

  it("nets a discounted sale and full return back to zero sale dollars", () => {
    const sale = saleContribution(
      {
        id: "discounted-sale",
        status: "CLOSED",
        line_items: [{ product_id: "p1", quantity: 1, total_price: "50", discount: "50" }],
      },
      seasonPidSet,
      pidToPrice
    );
    const returnLine = saleContribution(
      {
        id: "discounted-return",
        status: "CLOSED",
        line_items: [{ product_id: "p1", quantity: -1, total_price: "-50", discount_total: "50" }],
      },
      seasonPidSet,
      pidToPrice
    );

    const totals = {};
    addContribution(totals, sale);
    addContribution(totals, returnLine);

    expect(totals.p1).toMatchObject({
      sold: 0,
      onSale: 0,
      saleAmt: 0,
      soldAmt: 0,
      returned: 1,
    });
  });

  it("nets a partial discounted return against actual on-sale dollars", () => {
    const totals = {};
    addContribution(
      totals,
      saleContribution(
        {
          id: "discounted-sale-two",
          status: "CLOSED",
          line_items: [{ product_id: "p1", quantity: 2, total_price: "100", discount: "100" }],
        },
        seasonPidSet,
        pidToPrice
      )
    );
    addContribution(
      totals,
      saleContribution(
        {
          id: "discounted-return-one",
          status: "CLOSED",
          line_items: [
            { product_id: "p1", quantity: -1, total_price: "-50", discount_total: "50" },
          ],
        },
        seasonPidSet,
        pidToPrice
      )
    );

    expect(totals.p1).toMatchObject({
      sold: 0,
      onSale: 1,
      saleAmt: 50,
      soldAmt: 50,
      returned: 1,
    });
  });

  it("treats return lines with LS discount markers as on-sale returns", () => {
    const contribution = saleContribution(
      {
        id: "discounted-return-marker",
        status: "CLOSED",
        line_items: [
          {
            product_id: "p1",
            quantity: -1,
            total_price: "-100",
            price_book_id: "pb-1",
          },
        ],
      },
      seasonPidSet,
      pidToPrice
    );

    expect(contribution.perPid.p1).toMatchObject({
      sold: 0,
      onSale: -1,
      saleAmt: -100,
      soldAmt: -100,
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

describe("returnForId — original-sale link extraction (t4d)", () => {
  it("reads sale.return_for (the live LS field)", () => {
    expect(returnForId({ return_for: "orig-1" })).toBe("orig-1");
  });
  it("falls back to nested/legacy shapes then null", () => {
    expect(returnForId({ return: { original_sale_id: "orig-2" } })).toBe("orig-2");
    expect(returnForId({ original_sale_id: "orig-3" })).toBe("orig-3");
    expect(returnForId({ id: "no-link" })).toBeNull();
    expect(returnForId(null)).toBeNull();
  });
});

describe("returnBucketFromOriginal — unambiguous bucket only (t4d)", () => {
  it("returns the original bucket when one side is non-zero", () => {
    expect(returnBucketFromOriginal({ p1: { sold: 2, onSale: 0 } }, "p1")).toBe("sold");
    expect(returnBucketFromOriginal({ p1: { sold: 0, onSale: 1 } }, "p1")).toBe("onSale");
  });
  it("returns null when ambiguous, missing, or unknown pid", () => {
    expect(returnBucketFromOriginal({ p1: { sold: 1, onSale: 1 } }, "p1")).toBeNull();
    expect(returnBucketFromOriginal({ p1: { sold: 0, onSale: 0 } }, "p1")).toBeNull();
    expect(returnBucketFromOriginal({}, "p1")).toBeNull();
    expect(returnBucketFromOriginal(null, "p1")).toBeNull();
  });
});

describe("saleContribution — return bucketing via original sale (t4d)", () => {
  const seasonPidSet = new Set(["p1"]);
  const pidToPrice = { p1: 100 };

  // The hard case: a return line that carries NO discount markers and shows the
  // FULL unit price (so the heuristic would file it under `sold`), but the item
  // originally sold ON SALE. The original-sale link must override the heuristic.
  it("routes a marker-less return to onSale when the original sold on-sale", () => {
    const returnSale = {
      id: "ret-1",
      status: "CLOSED",
      return_for: "orig-1",
      line_items: [{ product_id: "p1", quantity: -1, total_price: "-100" }],
    };
    const originalPerPid = { p1: { sold: 0, onSale: 1, saleAmt: 50, soldAmt: 50, returned: 0 } };

    const withLink = saleContribution(returnSale, seasonPidSet, pidToPrice, { originalPerPid });
    expect(withLink.perPid.p1).toMatchObject({ sold: 0, onSale: -1, returned: 1 });

    // Without the link, the heuristic misfiles the same line as a `sold` return.
    const heuristic = saleContribution(returnSale, seasonPidSet, pidToPrice);
    expect(heuristic.perPid.p1).toMatchObject({ sold: -1, onSale: 0, returned: 1 });
  });

  it("routes a discount-marked return to sold when the original sold full price", () => {
    const returnSale = {
      id: "ret-2",
      status: "CLOSED",
      return_for: "orig-2",
      line_items: [{ product_id: "p1", quantity: -1, total_price: "-100", price_book_id: "pb-1" }],
    };
    const originalPerPid = { p1: { sold: 1, onSale: 0, saleAmt: 0, soldAmt: 100, returned: 0 } };

    const withLink = saleContribution(returnSale, seasonPidSet, pidToPrice, { originalPerPid });
    expect(withLink.perPid.p1).toMatchObject({ sold: -1, onSale: 0, returned: 1 });
  });

  it("falls back to the heuristic when the original is unknown or ambiguous", () => {
    const returnSale = {
      id: "ret-3",
      status: "CLOSED",
      return_for: "orig-missing",
      line_items: [{ product_id: "p1", quantity: -1, total_price: "-50", discount_total: "50" }],
    };
    // ambiguous original (both buckets) → heuristic; the discount marker → onSale
    const ambiguous = { p1: { sold: 1, onSale: 1 } };
    expect(
      saleContribution(returnSale, seasonPidSet, pidToPrice, { originalPerPid: ambiguous }).perPid.p1
    ).toMatchObject({ sold: 0, onSale: -1, returned: 1 });
    // no original at all → heuristic
    expect(saleContribution(returnSale, seasonPidSet, pidToPrice).perPid.p1).toMatchObject({
      sold: 0,
      onSale: -1,
      returned: 1,
    });
  });
});

describe("Layer 2 invariant — sold/onSale per-line exclusivity", () => {
  it("never places the same positive-qty line in both sold and onSale", () => {
    const seasonPidSet = new Set(["p1", "p2", "p3", "p4"]);
    const sale = {
      id: "mixed",
      status: "CLOSED",
      line_items: [
        { product_id: "p1", quantity: 2, total_price: "200" }, // full price
        { product_id: "p2", quantity: 1, total_price: "50", discount: "50" }, // discounted
        { product_id: "p3", quantity: 1, total_price: "0" }, // 100% off
        { product_id: "p4", quantity: 3, price: "100" }, // unit-price-only, full
      ],
    };
    const { perPid } = saleContribution(sale, seasonPidSet, {
      p1: 100,
      p2: 100,
      p3: 80,
      p4: 100,
    });
    for (const c of Object.values(perPid)) {
      // A line contributes to sold OR onSale, never both at once.
      expect(c.sold === 0 || c.onSale === 0).toBe(true);
    }
    expect(perPid.p1).toMatchObject({ sold: 2, onSale: 0 });
    expect(perPid.p2).toMatchObject({ sold: 0, onSale: 1 });
    expect(perPid.p3).toMatchObject({ sold: 0, onSale: 1 });
    expect(perPid.p4).toMatchObject({ sold: 3, onSale: 0 });
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

  it("applies sales totals without hiding net-negative quantities", () => {
    const productStats = {};
    applySalesTotals(productStats, {
      p1: { sold: -2, onSale: -1, saleAmt: -20, soldAmt: -120, returned: -1 },
    });

    expect(productStats.p1).toMatchObject({
      ...emptyProductStats(),
      sold: -2,
      onSale: -1,
      saleAmt: -20,
      soldAmt: -120,
      returned: -1,
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
    // Q2: Received is now PO-based (qtyReceived 8 − retQty 2 = 6 × 100 = 600),
    // independent of live on-hand — previously it was live-derived (700).
    expect(netReceivedRetail({ ...ps, liveOnHand: 4 }, 100)).toBe(600);
    expect(displayOnHand({ ...ps, liveOnHand: 9 })).toBe(9);
    expect(returnedRetailValue({ retQty: 2, retVal: 0 }, 100)).toBe(200);
    expect(returnedRetailValue({ retQty: 2, retVal: 150 }, 100)).toBe(150);

    expect(derivedOnHand({ qtyReceived: 1, sold: 2 })).toBe(0);
    expect(onOrderQty({ qtyOrdered: 1, qtyReceived: 3 })).toBe(0);
    expect(netOrderedValue({ qtyOrdered: 1, retQty: 3 }, 100)).toBe(0);
    expect(netReceivedValue({ qtyReceived: 1, retQty: 3 }, 100)).toBe(0);
  });
});

describe("netReceivedUnits — PO-based with consignment fallback (Q2)", () => {
  it("drives Received from PO qtyReceived net of vendor returns", () => {
    // 8 received, 2 returned to vendor → 6, regardless of live on-hand.
    const ps = { qtyReceived: 8, retQty: 2, sold: 3, onSale: 1, liveOnHand: 4 };
    expect(netReceivedUnits(ps)).toBe(6);
    expect(netReceivedRetail(ps, 100)).toBe(600); // header stays net of returns
  });

  it("does NOT change when live on-hand is manually dropped", () => {
    // Same PO (received 8, returned 0) but a manual LS on-hand correction from
    // 5 down to 1. PO-based Received and sell-through must be unaffected.
    const before = { qtyReceived: 8, retQty: 0, sold: 3, onSale: 0, liveOnHand: 5 };
    const after = { ...before, liveOnHand: 1 };
    expect(netReceivedUnits(before)).toBe(8);
    expect(netReceivedUnits(after)).toBe(8);
    // Sell-through (sold / received) is identical before and after the edit.
    const stBefore = before.sold / netReceivedUnits(before);
    const stAfter = after.sold / netReceivedUnits(after);
    expect(stAfter).toBeCloseTo(stBefore, 9);
  });

  it("falls back to live-derived received for consignment/no-PO products", () => {
    // qtyReceived 0 → consignment: received = onHand + sold + onSale.
    const ps = { qtyReceived: 0, retQty: 0, sold: 2, onSale: 1, liveOnHand: 3 };
    expect(netReceivedUnits(ps)).toBe(6); // 3 + 2 + 1
    expect(netReceivedRetail(ps, 50)).toBe(300);
  });

  it("caps received cost at $0 for fully-returned consignment goods", () => {
    const ps = { qtyReceived: 2, retQty: 2, sold: 0, onSale: 0, liveOnHand: 0 };
    expect(netReceivedUnits(ps)).toBe(0);
    expect(netReceivedCost(ps, 30)).toBe(0);
  });
});

describe("mismatchDerivedStock — consignment fallback (Q1b)", () => {
  it("uses PO math when there is a PO record", () => {
    expect(mismatchDerivedStock({ qtyReceived: 5, sold: 2, onSale: 1, retQty: 1 })).toBe(1);
  });

  it("tracks live on-hand for no-PO products so they are not flagged", () => {
    // qtyReceived 0, live 4 → derived 4 (== live), delta 0.
    expect(mismatchDerivedStock({ qtyReceived: 0, liveOnHand: 4, sold: 3, onSale: 1 })).toBe(4);
    // nets any vendor returns off the live count.
    expect(mismatchDerivedStock({ qtyReceived: 0, liveOnHand: 4, retQty: 1 })).toBe(3);
  });

  it("returns 0 for a no-PO product with no live on-hand", () => {
    expect(mismatchDerivedStock({ qtyReceived: 0, liveOnHand: null })).toBe(0);
  });
});

describe("returnedCostValue / returnedRetailValue — stored-wins, never negative (3c)", () => {
  it("prefers a stored positive retCost/retVal over qty × unit", () => {
    expect(returnedCostValue({ retQty: 2, retCost: 150 }, 40)).toBe(150);
    expect(returnedRetailValue({ retQty: 2, retVal: 150 }, 100)).toBe(150);
  });
  it("falls back to retQty × cost/price when stored value is 0", () => {
    expect(returnedCostValue({ retQty: 2, retCost: 0 }, 40)).toBe(80);
    expect(returnedRetailValue({ retQty: 2, retVal: 0 }, 100)).toBe(200);
  });
  it("never returns negative and tolerates missing fields", () => {
    expect(returnedCostValue({ retQty: 0 }, 40)).toBe(0);
    expect(returnedCostValue({}, 40)).toBe(0);
    expect(returnedCostValue({ retQty: 3 }, 0)).toBe(0);
    expect(returnedCostValue(null, 40)).toBe(0);
  });
});

describe("netReceivedUnits — no-PO consignment with a vendor return (3c)", () => {
  it("uses the live-derived received and ignores retQty in the fallback branch", () => {
    // qtyReceived 0 (consignment/migrated) but a vendor return exists. The
    // fallback received tracks live on-hand + sold + onSale; retQty does not
    // double-subtract here (live on-hand already reflects the return).
    const ps = { qtyReceived: 0, retQty: 2, sold: 1, onSale: 0, liveOnHand: 3 };
    expect(netReceivedUnits(ps)).toBe(4); // 3 + 1 + 0
    expect(netReceivedCost(ps, 25)).toBe(100);
  });
});

describe("saleContribution — discount-marker shapes (3c)", () => {
  const seasonPidSet = new Set(["p1"]);

  function onSaleOf(line, pidToPrice = { p1: 100 }) {
    return saleContribution(
      { id: "s", status: "CLOSED", line_items: [{ product_id: "p1", quantity: 1, ...line }] },
      seasonPidSet,
      pidToPrice
    ).perPid.p1;
  }

  it("classifies an implicit discount (unit < retail, no marker) as onSale", () => {
    // No discount field at all; unit price 80 < pidToPrice 100 → onSale.
    expect(onSaleOf({ total_price: "80" })).toMatchObject({ sold: 0, onSale: 1, saleAmt: 80 });
  });

  it("treats a full-price line (no marker, unit == retail) as sold", () => {
    expect(onSaleOf({ total_price: "100" })).toMatchObject({ sold: 1, onSale: 0 });
  });

  it("uses price_total as the line total when total_price is absent", () => {
    expect(onSaleOf({ price_total: "50", discount: "50" })).toMatchObject({
      sold: 0,
      onSale: 1,
      saleAmt: 50,
    });
  });

  it("honors discount_percent, discounts[], is_discounted and was_discounted markers", () => {
    expect(onSaleOf({ total_price: "100", discount_percent: "10" })).toMatchObject({ onSale: 1 });
    expect(onSaleOf({ total_price: "100", discounts: [{ amount: "5" }] })).toMatchObject({
      onSale: 1,
    });
    expect(onSaleOf({ total_price: "100", is_discounted: true })).toMatchObject({ onSale: 1 });
    expect(onSaleOf({ total_price: "100", was_discounted: true })).toMatchObject({ onSale: 1 });
  });

  it("ignores a zero-amount discounts[] entry (stays sold at full price)", () => {
    expect(onSaleOf({ total_price: "100", discounts: [{ amount: "0" }] })).toMatchObject({
      sold: 1,
      onSale: 0,
    });
  });
});

describe("date and product helpers", () => {
  it("computes fallback sales dates and date offsets", () => {
    expect(seasonSalesFallbackDate("spring26")).toBe("2025-02-01");
    expect(seasonSalesFallbackDate("fall26")).toBe("2025-08-01");
    expect(seasonSalesFallbackDate("bad")).toBeNull();
    expect(dateMinusDays("2026-03-10", 7)).toBe("2026-03-03");
    expect(dateMinusDays("bad-date", 7)).toBeNull();
    expect(seasonScanDateRange("spring26")).toEqual({
      start: "2024-02-02",
      end: "2026-07-31",
    });
    expect(dateInRange("2026-06-01", seasonScanDateRange("spring26"))).toBe(true);
    expect(dateInRange("2026-09-01", seasonScanDateRange("spring26"))).toBe(false);
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
