// pages/api/debug-flow.js — temporary diagnostic endpoint, remove after debugging
export default async function handler(req, res) {
  const accessToken = process.env.LS_ACCESS_TOKEN;
  const domainPrefix = process.env.LS_DOMAIN_PREFIX;

  if (!accessToken || !domainPrefix) {
    return res.status(500).json({ error: "Lightspeed credentials not configured" });
  }

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function lsFetch(path) {
    const r = await fetch(`${base}/${path}`, { headers });
    return r.json();
  }

  try {
    // 1. Sample product types
    const types = await lsFetch("2.0/product_types?page_size=5");

    // 2. Sample consignments
    const consignments = await lsFetch("2.0/consignments?type=SUPPLIER&page_size=5");

    // 3. Products for first consignment
    let consigProducts = null;
    const firstConsig = consignments?.data?.[0];
    if (firstConsig) {
      consigProducts = await lsFetch(`2.0/consignments/${firstConsig.id}/products?page_size=5`);
    }

    // 4. Look up the actual product record for the first consignment product
    let lookedUpProduct = null;
    const firstConsigProduct = consigProducts?.data?.[0];
    if (firstConsigProduct?.product_id) {
      const r = await lsFetch(`2.0/products/${firstConsigProduct.product_id}`);
      lookedUpProduct = r?.data || r;
    }

    // 5. Look up the same product with deleted=true (in case it was deleted)
    let lookedUpDeletedProduct = null;
    if (firstConsigProduct?.product_id) {
      const r = await lsFetch(`2.0/products/${firstConsigProduct.product_id}?deleted=true`);
      lookedUpDeletedProduct = r?.data || r;
    }

    // 6. Count how many products are returned with deleted=true (pagination check)
    const productsPage1 = await lsFetch("2.0/products?deleted=true&page_size=200");
    const productsCount = productsPage1?.data?.length;
    const productsPagination = productsPage1?.pagination || productsPage1?.meta?.pagination || productsPage1?.version;

    // 7. Find a product with a product_type_id set
    const productWithType = productsPage1?.data?.find(p => p.product_type_id);

    res.status(200).json({
      product_types_sample: types?.data?.slice(0, 3),
      consignment_count: consignments?.data?.length,
      first_consig_id: firstConsig?.id,
      consig_products_sample: consigProducts?.data?.slice(0, 3),
      // The actual product record for a consignment line item:
      looked_up_product: {
        id: lookedUpProduct?.id,
        name: lookedUpProduct?.name,
        product_type_id: lookedUpProduct?.product_type_id,
        deleted_at: lookedUpProduct?.deleted_at,
        active: lookedUpProduct?.active,
      },
      looked_up_deleted_product: {
        id: lookedUpDeletedProduct?.id,
        name: lookedUpDeletedProduct?.name,
        product_type_id: lookedUpDeletedProduct?.product_type_id,
        deleted_at: lookedUpDeletedProduct?.deleted_at,
      },
      // Pagination info for products with deleted=true
      products_page1_count: productsCount,
      products_pagination: productsPagination,
      // A product that actually has a category:
      sample_product_with_type: productWithType ? {
        id: productWithType.id,
        name: productWithType.name,
        product_type_id: productWithType.product_type_id,
        deleted_at: productWithType.deleted_at,
      } : "none found in first 200",
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
