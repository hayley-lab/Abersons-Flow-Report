// pages/api/import/datatail.js
import { getIronSession } from "iron-session";
import fetch from "node-fetch";
import { kv } from "@vercel/kv";

const SESSION_OPTIONS = {
  cookieName: "flow_session",
  password: process.env.SESSION_SECRET,
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
};

const BASE = "https://datatailor.abersonstyle.com";

async function dtFetch(path, cookies) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(BASE + path, {
      headers: {
        Cookie: cookies,
        "User-Agent": "Mozilla/5.0 (compatible; FlowImport/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("datatail HTTP " + res.status + " for " + path);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseDollar(s) {
  if (!s) return 0;
  return parseFloat(s.replace(/[$,\s]/g, "")) || 0;
}

function stripTags(s) {
  return (s || "").replace(/<[^>]*>/g, "").trim();
}

// Parse current season label and prev/next titles from the root page
function parseSeasonInfo(html) {
  const prevM =
    /class="selectprevious"[^>]*title="([^"]+)"/.exec(html) ||
    /title="([^"]+)"[^>]*class="selectprevious"/.exec(html);
  const nextM =
    /class="selectnext"[^>]*title="([^"]+)"/.exec(html) ||
    /title="([^"]+)"[^>]*class="selectnext"/.exec(html);
  return {
    prev: prevM ? prevM[1] : null,
    next: nextM ? nextM[1] : null,
  };
}

// Parse store rows from the root summary page
// Each row: <td data-label="Store"><a href="/store/7">Accessories</a></td> + dollar cells
function parseStores(html) {
  const stores = [];
  const rowRe = /<tr[^>]*class="row"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null) {
    const row = rowM[1];
    const storeM = /href="\/store\/(\d+)">([^<]+)<\/a>/.exec(row);
    if (!storeM) continue;
    const getLabel = (label) => {
      const re = new RegExp('data-label="' + label + '"[^>]*>([^<]+)<', "i");
      const m = re.exec(row);
      return m ? m[1].trim() : "";
    };
    stores.push({
      id: storeM[1],
      name: storeM[2].trim(),
      ordered: parseDollar(getLabel("Ordered")),
      received: parseDollar(getLabel("Received")),
      sold: parseDollar(getLabel("Sold")),
    });
  }
  return stores;
}

// Parse vendor rows from a /store/{id} page
// Each row has a link like <a href="/vendor/439/department/7">Vendor Name</a>
function parseStoreVendors(html, storeId, storeName) {
  const vendors = [];
  const linkRe = /href="\/vendor\/(\d+)\/department\/(\d+)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    vendors.push({
      vendorId: m[1],
      deptId: m[2],
      vendorName: m[3].trim(),
      storeId,
      storeName,
    });
  }
  // Also grab dollar totals per vendor from data-label cells
  const rowRe = /<tr[^>]*class="row"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null) {
    const row = rowM[1];
    const vendorLinkM = /href="\/vendor\/(\d+)\/department\/(\d+)"[^>]*>([^<]+)<\/a>/.exec(row);
    if (!vendorLinkM) continue;
    const vid = vendorLinkM[1],
      did = vendorLinkM[2];
    const getLabel = (label) => {
      const re = new RegExp('data-label="' + label + '"[^>]*>([^<\\n]+)<', "i");
      const mr = re.exec(row);
      return mr ? mr[1].trim() : "";
    };
    const existing = vendors.find((v) => v.vendorId === vid && v.deptId === did);
    if (existing) {
      existing.ordered = parseDollar(getLabel("Ordered"));
      existing.received = parseDollar(getLabel("Received"));
      existing.sold = parseDollar(getLabel("Sold"));
    }
  }
  return vendors;
}

// Parse vendor detail page (/vendor/{id}/department/{id})
function parseVendorDetail(html) {
  // Totals are in data-label cells in the totals table
  const getLabel = (label) => {
    const re = new RegExp('data-label="' + label + '"[^>]*>([^<\\n]+)<', "i");
    const m = re.exec(html);
    return m ? parseDollar(m[1]) : 0;
  };
  const ordered = getLabel("Ordered");
  const received = getLabel("Received");
  const sold = getLabel("Sold");

  // Find the items table — has headers: Status, Description, Style, Color, Fabric, Size, Cost, Price
  const products = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tMatch;
  while ((tMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tMatch[1];
    if (!tableHtml.includes("Description") || !tableHtml.includes("Style")) continue;

    // Parse header order
    const headers = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let hm;
    while ((hm = thRe.exec(tableHtml)) !== null)
      headers.push(stripTags(hm[1]).toLowerCase().trim());

    const idx = (name) => headers.findIndex((h) => h.includes(name));
    const descIdx = idx("description");
    const styleIdx = idx("style");
    const colorIdx = idx("color");
    const fabricIdx = idx("fabric");
    const sizeIdx = idx("size");
    const costIdx = idx("cost");
    const priceIdx = idx("price");

    if (descIdx === -1) continue;

    const rowRe2 = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowM;
    while ((rowM = rowRe2.exec(tableHtml)) !== null) {
      const rowHtml = rowM[1];
      if (rowHtml.includes("<th")) continue; // skip header row
      const cells = [];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = tdRe.exec(rowHtml)) !== null) cells.push(cm[1]);
      if (cells.length < 3) continue;

      const getText = (i) => (i >= 0 && i < cells.length ? stripTags(cells[i]) : "");
      const price = parseDollar(getText(priceIdx));
      const desc = getText(descIdx);
      if (!price && !desc) continue;

      // Parse status tally marks. Legacy datatailor labels in-stock atoms
      // with class "received"; keep "stock" as a compatibility fallback.
      const statusCell = cells[0] || ""; // Status is always first column
      const countClass = (cls) =>
        (statusCell.match(new RegExp('class="[^"]*' + cls + '[^"]*"', "g")) || []).length;

      products.push({
        description: desc,
        style: getText(styleIdx),
        color: getText(colorIdx),
        fabric: getText(fabricIdx),
        size: getText(sizeIdx),
        cost: parseDollar(getText(costIdx)),
        price,
        qtyOrdered: countClass("ordered"),
        qtyStock: countClass("received") || countClass("stock"),
        qtySold: countClass("sold"),
        qtySale: countClass("sale"),
        qtyReturned: countClass("returned"),
      });
    }
    break;
  }

  return { ordered, received, sold, products };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getIronSession(req, res, SESSION_OPTIONS);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { action, phpsessid, rememberme } = req.body || {};
  if (!phpsessid && !rememberme)
    return res.status(400).json({ error: "Provide at least one cookie value" });

  const cookies = [
    phpsessid ? `PHPSESSID=${phpsessid}` : "",
    rememberme ? `REMEMBERME=${rememberme}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  try {
    if (action === "probe") {
      const html = await dtFetch("/", cookies);
      const loggedIn = html.includes("logout") || html.includes("Store Summary");
      if (!loggedIn) return res.json({ ok: false, error: "Cookies invalid — not logged in" });
      const seasonInfo = parseSeasonInfo(html);
      // Infer current season: it's the season after prev (or before next)
      // e.g. prev=fall 2024, next=fall 2025 → current=spring 2025
      function nextSeason(label) {
        if (!label) return null;
        const m = /(spring|fall)\s+(\d{4})/i.exec(label);
        if (!m) return null;
        const [, term, yearStr] = m;
        const year = parseInt(yearStr, 10);
        return term.toLowerCase() === "fall" ? `spring ${year + 1}` : `fall ${year}`;
      }
      const current = nextSeason(seasonInfo.prev) || "unknown";
      return res.json({ ok: true, current, ...seasonInfo });
    }

    if (action === "fetchStores") {
      const html = await dtFetch("/", cookies);
      const stores = parseStores(html);
      const seasonInfo = parseSeasonInfo(html);
      return res.json({ ok: true, stores, ...seasonInfo });
    }

    if (action === "fetchStoreVendors") {
      const { storeId, storeName } = req.body;
      const html = await dtFetch(`/store/${storeId}`, cookies);
      const vendors = parseStoreVendors(html, storeId, storeName);
      return res.json({ ok: true, vendors });
    }

    if (action === "fetchVendorDetail") {
      const {
        vendorId,
        deptId,
        season,
        vendorName,
        deptName,
        storeOrdered,
        storeReceived,
        storeSold,
      } = req.body;
      const html = await dtFetch(`/vendor/${vendorId}/department/${deptId}`, cookies);
      const data = parseVendorDetail(html);

      // If season provided, save directly to KV to avoid large batch POST bodies
      if (season) {
        const TTL = 60 * 60 * 24 * 30;
        const key = `${deptId}__${vendorId}`;
        const vendorRecord = {
          vendorId,
          vendorName: vendorName || "",
          deptId,
          deptName: deptName || "",
          ordered: data.ordered || storeOrdered || 0,
          received: data.received || storeReceived || 0,
          sold: data.sold || storeSold || 0,
          products: data.products,
        };
        await kv.set(`scan:override:${season}:v:${key}`, JSON.stringify(vendorRecord), { ex: TTL });
      }

      return res.json({
        ok: true,
        ordered: data.ordered,
        received: data.received,
        sold: data.sold,
        productCount: data.products.length,
      });
    }

    if (action === "finalizeImport") {
      const { season, stores, vendorKeys } = req.body;
      if (!season) return res.status(400).json({ error: "season required" });
      const TTL = 60 * 60 * 24 * 30;
      const TTL_OPTS = { ex: TTL };

      if (stores && Object.keys(stores).length > 0) {
        await kv.set(`scan:override:${season}:stores`, JSON.stringify(stores), TTL_OPTS);
      }

      if (vendorKeys && vendorKeys.length > 0) {
        const existingRaw = await kv.get(`scan:override:${season}:vendorIndex`);
        const existing = existingRaw
          ? typeof existingRaw === "string"
            ? JSON.parse(existingRaw)
            : existingRaw
          : [];
        const merged = Array.from(new Set([...existing, ...vendorKeys]));
        await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(merged), TTL_OPTS);
      }

      return res.json({ ok: true, season, vendorCount: vendorKeys ? vendorKeys.length : 0 });
    }

    if (action === "debugHtml") {
      const { path: debugPath } = req.body;
      const html = await dtFetch(debugPath || "/", cookies);
      return res.json({ ok: true, html: html.slice(0, 8000), length: html.length });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
