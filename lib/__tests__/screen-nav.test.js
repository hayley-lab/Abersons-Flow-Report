import { resolveFallbackScreen, SCREEN } from "../screen-nav";

describe("resolveFallbackScreen", () => {
  const accessories = { id: "acc", name: "Accessories" };
  const judi = { id: "judi", name: "Judi Powers" };
  const vendorList = [judi, { id: "staud", name: "Staud" }];
  const deptList = [accessories, { id: "shoes", name: "Shoes" }];

  it("stays on the summary screen (no fallback)", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.SUMMARY,
        currentDept: accessories,
        currentVendor: judi,
        summaryRows: deptList,
        vendorRows: vendorList,
      })
    ).toBeNull();
  });

  // Regression: the department drilldown is the "vendors" screen. A stale
  // currentVendor left over from a prior drilldown must NOT trigger a fallback
  // here — doing so previously flipped the screen to a dead "dept" id and blanked
  // the page at routes like /spring26/categories/accessories.
  it("does not fall back on the department drilldown when a stale vendor is set", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.VENDORS,
        currentDept: accessories,
        currentVendor: { id: "gone", name: "Vendor From Another Dept" },
        summaryRows: deptList,
        vendorRows: vendorList,
      })
    ).toBeNull();
  });

  it("never returns the non-existent 'dept' screen", () => {
    const cases = [SCREEN.SUMMARY, SCREEN.VENDORS, SCREEN.PRODUCTS, SCREEN.DETAIL].map((screen) =>
      resolveFallbackScreen({
        screen,
        currentDept: { id: "missing", name: "Missing Dept" },
        currentVendor: { id: "missing", name: "Missing Vendor" },
        summaryRows: deptList,
        vendorRows: vendorList,
      })
    );
    for (const next of cases) {
      expect(next).not.toBe("dept");
    }
  });

  it("falls back to summary when the drilled-in department vanished", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.VENDORS,
        currentDept: { id: "gone", name: "Removed Dept" },
        currentVendor: null,
        summaryRows: deptList,
        vendorRows: [],
      })
    ).toBe(SCREEN.SUMMARY);
  });

  it("does not fall back before department data has loaded", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.VENDORS,
        currentDept: { id: "gone", name: "Removed Dept" },
        currentVendor: null,
        summaryRows: [],
        vendorRows: [],
      })
    ).toBeNull();
  });

  it("falls back from products to the department drilldown when the vendor vanished", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.PRODUCTS,
        currentDept: accessories,
        currentVendor: { id: "gone", name: "Removed Vendor" },
        summaryRows: deptList,
        vendorRows: vendorList,
      })
    ).toBe(SCREEN.VENDORS);
  });

  it("falls back from products to summary when a vanished vendor has no department context", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.PRODUCTS,
        currentDept: null,
        currentVendor: { id: "gone", name: "Removed Vendor" },
        summaryRows: deptList,
        vendorRows: vendorList,
      })
    ).toBe(SCREEN.SUMMARY);
  });

  it("does not disturb an all-departments vendor on the products screen", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.PRODUCTS,
        currentDept: null,
        currentVendor: { id: "judi", name: "Judi Powers", allDepts: true },
        summaryRows: deptList,
        vendorRows: vendorList,
      })
    ).toBeNull();
  });

  it("stays on products while the vendor still exists", () => {
    expect(
      resolveFallbackScreen({
        screen: SCREEN.PRODUCTS,
        currentDept: accessories,
        currentVendor: judi,
        summaryRows: deptList,
        vendorRows: vendorList,
      })
    ).toBeNull();
  });
});
