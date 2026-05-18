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
    // Full record of "Nala Dress" (a consignment product with product_type_id=null)
    const nala = await lsFetch("2.0/products/5d7b3c11-ccb3-43ff-9f33-38f984412ad7?deleted=true");
    const nalaFull = nala?.data || nala;

    // Full record of "My Girl Sunglasses" (has a product_type_id)
    const sunglasses = await lsFetch("2.0/products/051c2a99-bfe7-4a4a-9558-0bd2e99cedb4?deleted=true");
    const sunglassesFull = sunglasses?.data || sunglasses;

    // Test version-based pagination: page 2 using version.max from page 1
    const page1 = await lsFetch("2.0/products?deleted=true&page_size=200");
    const versionMax = page1?.version?.max;
    let page2Count = null;
    let page2VersionMax = null;
    if (versionMax) {
      const page2 = await lsFetch(`2.0/products?deleted=true&page_size=200&after=${versionMax}`);
      page2Count = page2?.data?.length;
      page2VersionMax = page2?.version?.max;
    }

    // Check what product_type_id "4d75d47b-..." maps to (from My Girl Sunglasses)
    const sunglassesTypeId = sunglassesFull?.product_type_id;
    let sunglassesType = null;
    if (sunglassesTypeId) {
      const r = await lsFetch(`2.0/product_types/${sunglassesTypeId}`);
      sunglassesType = r?.data || r;
    }

    res.status(200).json({
      nala_dress_full: nalaFull,
      sunglasses_full: sunglassesFull,
      sunglasses_type: sunglassesType,
      pagination_test: {
        page1_count: page1?.data?.length,
        page1_version_max: versionMax,
        page2_count: page2Count,
        page2_version_max: page2VersionMax,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
}
