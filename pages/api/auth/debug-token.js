// pages/api/auth/debug-token.js — test tag-based product filtering
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  const { accessToken, domainPrefix } = session;
  if (!accessToken || !domainPrefix) return res.status(401).json({ error: "Not authenticated" });

  const base = `https://${domainPrefix}.retail.lightspeed.app/api`;
  const hdrs = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  async function ls(path) {
    const r = await fetch(`${base}/${path}`, { headers: hdrs });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: r.status, ok: r.ok, body };
  }

  // Find prefall26 tag
  const tagsRes = await ls("2.0/tags?page_size=200");
  const seasonTag = tagsRes.body?.data?.find((t) => t.name === "prefall26");
  if (!seasonTag) return res.status(200).json({ error: "prefall26 tag not found" });

  // Test 1: products filtered by tag_id query param
  const test1 = await ls(`2.0/products?tag_id=${seasonTag.id}&page_size=5`);

  // Test 2: products filtered by tag_ids[] array param
  const test2 = await ls(`2.0/products?tag_ids[]=${seasonTag.id}&page_size=5`);

  // Test 3: tags/{id}/products sub-resource
  const test3 = await ls(`2.0/tags/${seasonTag.id}/products?page_size=5`);

  // Test 4: fetch one known 404 product to see the error body
  const consignRes = await ls("2.0/consignments?type=SUPPLIER&page_size=1");
  const firstConsign = consignRes.body?.data?.[0];
  let productFetchTest = null;
  if (firstConsign?.id) {
    const liRes = await ls(`2.0/consignments/${firstConsign.id}/products?page_size=3`);
    const pids = liRes.body?.data?.map((li) => li.product_id) ?? [];
    productFetchTest = await Promise.all(
      pids.map(async (pid) => {
        const r = await ls(`2.0/products/${pid}`);
        return {
          pid,
          status: r.status,
          has_data: !!r.body?.data?.id,
          keys: r.body?.data ? Object.keys(r.body.data).slice(0, 5) : null,
          error: r.body?.errors,
        };
      })
    );
  }

  res.status(200).json({
    season_tag: { id: seasonTag.id, name: seasonTag.name },
    tag_filter_tests: {
      "products?tag_id=X": {
        status: test1.status,
        count: test1.body?.data?.length,
        sample_name: test1.body?.data?.[0]?.name,
      },
      "products?tag_ids[]=X": {
        status: test2.status,
        count: test2.body?.data?.length,
        sample_name: test2.body?.data?.[0]?.name,
      },
      "tags/{id}/products": {
        status: test3.status,
        count: test3.body?.data?.length,
        sample_name: test3.body?.data?.[0]?.name,
        error: test3.body?.errors,
      },
    },
    product_fetch_test: productFetchTest,
  });
}
