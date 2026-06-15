import {
  isResolvedSupplier,
  normVendorName,
  sameVendorBucket,
  supplierId,
  supplierName,
  vendorIdentityFromLs,
  vendorBucketKey,
} from "../vendor-match";

describe("supplier field readers (dual format)", () => {
  it("reads {i,n} and {id,name}", () => {
    expect(supplierId({ i: "942", n: "Staud" })).toBe("942");
    expect(supplierId({ id: "942", name: "Staud" })).toBe("942");
    expect(supplierName({ i: "942", n: "Staud" })).toBe("Staud");
    expect(supplierName({ id: "942", name: "Staud" })).toBe("Staud");
    expect(supplierId(null)).toBeNull();
  });

  it("treats __none__ / missing as unresolved", () => {
    expect(isResolvedSupplier({ i: "__none__" })).toBe(false);
    expect(isResolvedSupplier(null)).toBe(false);
    expect(isResolvedSupplier({ id: "942" })).toBe(true);
  });
});

describe("vendorIdentityFromLs", () => {
  it("prefers LS brand over supplier", () => {
    expect(
      vendorIdentityFromLs({
        brand: { id: "brand1", name: "Staud" },
        supplier: { id: "supplier1", name: "Shared Supplier" },
      })
    ).toEqual({ id: "brand1", name: "Staud" });
  });

  it("falls back to brand_id and then supplier identity", () => {
    expect(vendorIdentityFromLs({ brand_id: "brand2", supplier_id: "supplier2" })).toEqual({
      id: "brand2",
      name: "Unknown",
    });
    expect(vendorIdentityFromLs({ supplier: { id: "supplier3", name: "Supplier" } })).toEqual({
      id: "supplier3",
      name: "Supplier",
    });
  });

  it("returns Unknown when neither brand nor supplier is present", () => {
    expect(vendorIdentityFromLs({})).toEqual({ id: "__none__", name: "Unknown" });
  });
});

describe("vendorBucketKey", () => {
  it("groups a brand by normalized name regardless of id format/value", () => {
    expect(vendorBucketKey({ i: "942", n: "Staud" })).toBe("staud");
    expect(vendorBucketKey({ id: "2dec4dad", name: "Staud" })).toBe("staud");
    expect(vendorBucketKey({ id: "942", name: "Frank & Eileen" })).toBe("frankeileen");
  });

  it("buckets unresolved suppliers under __unassigned__", () => {
    expect(vendorBucketKey({ i: "__none__", n: "Unknown" })).toBe("__unassigned__");
    expect(vendorBucketKey(null)).toBe("__unassigned__");
  });

  it("falls back to id when no name", () => {
    expect(vendorBucketKey({ id: "942" })).toBe("942");
  });
});

describe("sameVendorBucket", () => {
  it("matches by normalized name when ids differ (datatail numeric vs LS uuid)", () => {
    const sup = { i: "942", n: "Staud" };
    const vendorRow = { id: "2dec4dad-uuid", name: "Staud" };
    expect(sameVendorBucket(sup, vendorRow)).toBe(true);
  });

  it("does not match by id when names differ", () => {
    expect(sameVendorBucket({ i: "942", n: "Staud" }, { id: "942", name: "X" })).toBe(false);
  });

  it("does not match a different brand", () => {
    expect(sameVendorBucket({ i: "111", n: "Nili Lotan" }, { id: "942", name: "Staud" })).toBe(
      false
    );
  });

  it("__unassigned__ row collects only products with no resolved supplier", () => {
    expect(
      sameVendorBucket({ i: "__none__" }, { id: "__unassigned__", name: "Unassigned" })
    ).toBe(true);
    expect(sameVendorBucket(null, { id: "__unassigned__", name: "Unassigned" })).toBe(true);
    expect(
      sameVendorBucket({ i: "942", n: "Staud" }, { id: "__unassigned__", name: "Unassigned" })
    ).toBe(false);
  });

  it("normVendorName strips named and numeric entities, case, punctuation", () => {
    expect(normVendorName("Frank &amp; Eileen")).toBe("frankeileen");
    expect(normVendorName("Levi&#039;s")).toBe("levis");
    expect(normVendorName("Levi's")).toBe("levis");
    expect(normVendorName("A Piece Apart")).toBe("apieceapart");
  });
});
