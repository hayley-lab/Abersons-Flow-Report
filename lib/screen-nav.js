// Screen identifiers used by the flow report drilldown UI.
//   summary  — store summary (department / vendor list)
//   vendors  — department drilldown (list of vendors within one department)
//   products — a single vendor's product list
//   detail   — single product detail
// NOTE: there is intentionally no "dept" screen. An earlier refactor renamed
// the department drilldown from "dept" to "vendors" and the vendor product
// list from "vendors" to "products". Falling back to a non-existent screen
// blanks the page (header only, empty body), so all navigation must use the
// identifiers below.
export const SCREEN = {
  SUMMARY: "summary",
  VENDORS: "vendors",
  PRODUCTS: "products",
  DETAIL: "detail",
};

function existsBy(list, target) {
  if (!target || !Array.isArray(list)) return false;
  return list.some((r) => r.id === target.id || r.name === target.name);
}

// After season data reloads, decide whether the current drilldown screen must
// fall back because the department or vendor it points at no longer exists in
// the freshly-loaded data. Returns the screen id to switch to, or null to stay
// on the current screen.
export function resolveFallbackScreen({
  screen,
  currentDept,
  currentVendor,
  summaryRows = [],
  vendorRows = [],
}) {
  // Department drilldown: if the department vanished, return to the summary.
  if (screen === SCREEN.VENDORS) {
    if (currentDept && summaryRows.length > 0 && !existsBy(summaryRows, currentDept)) {
      return SCREEN.SUMMARY;
    }
    return null;
  }

  // Vendor product list: if a department-scoped vendor vanished, fall back to
  // the department drilldown (or the summary when there is no department
  // context, e.g. an all-departments vendor opened from the summary).
  if (screen === SCREEN.PRODUCTS) {
    const deptScoped = currentVendor && !currentVendor.allDepts;
    if (deptScoped && vendorRows.length > 0 && !existsBy(vendorRows, currentVendor)) {
      return currentDept ? SCREEN.VENDORS : SCREEN.SUMMARY;
    }
    return null;
  }

  return null;
}
