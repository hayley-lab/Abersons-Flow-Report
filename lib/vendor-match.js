// Vendor identity helpers.
//
// A brand (vendor) is identified by NAME, not by supplier id. The same brand
// can carry two different supplier ids across the data set — the LS supplier
// UUID and the datatail numeric id — and conversely several brands can share
// one LS supplier id. So product→vendor attribution and the finalize rollup
// match on the normalized brand name, falling back to the id only when needed.
//
// pidToSupplier comes in two shapes:
//   - { i, n }      written by registerProduct (LS scan)
//   - { id, name }  written when applying a datatail override vendor
// These helpers read both.

export function normVendorName(s) {
  return (s || "")
    .replace(/&[a-z]+;/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function supplierId(sup) {
  if (!sup) return null;
  return sup.i || sup.id || null;
}

export function supplierName(sup) {
  if (!sup) return null;
  return sup.n || sup.name || null;
}

export function vendorIdentityFromLs(p) {
  const brandId = p?.brand?.id || p?.brand_id;
  const brandName = p?.brand?.name;
  if (brandId || brandName) {
    return { id: brandId || brandName, name: brandName || "Unknown" };
  }

  const lsSupplierId = p?.supplier?.id || p?.supplier_id;
  const lsSupplierName = p?.supplier?.name;
  if (lsSupplierId || lsSupplierName) {
    return { id: lsSupplierId || lsSupplierName, name: lsSupplierName || "Unknown" };
  }

  return { id: "__none__", name: "Unknown" };
}

export function isResolvedSupplier(sup) {
  const id = supplierId(sup);
  return !!id && id !== "__none__";
}

// Finalize bucket key: one bucket per brand. Group by normalized name so a brand
// whose products carry different supplier ids still rolls into a single vendor
// row; fall back to the id when no name is available.
export function vendorBucketKey(sup) {
  if (!isResolvedSupplier(sup)) return "__unassigned__";
  return normVendorName(supplierName(sup)) || String(supplierId(sup));
}

// Drilldown predicate: does a product's supplier belong to this vendor row?
// Matches by id OR normalized name so attribution survives the dual-id split.
// The synthetic "__unassigned__" row collects products with no resolved supplier.
export function productMatchesVendor(sup, vendor) {
  if (!vendor) return false;
  const id = supplierId(sup);
  if (String(vendor.id) === "__unassigned__") {
    return !id || id === "__none__";
  }
  if (id && String(id) === String(vendor.id)) return true;
  const vn = normVendorName(vendor.name);
  const sn = normVendorName(supplierName(sup));
  return !!vn && !!sn && vn === sn;
}
