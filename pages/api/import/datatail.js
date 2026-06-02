// pages/api/import/datatail.js
// Scrapes datatailor.abersonstyle.com and stores override data in KV
import { getIronSession } from "iron-session";
import { kv } from "@vercel/kv";
import fetch from "node-fetch";

const SESSION_OPTIONS = {
  cookieName: "flow_session",
  password: process.env.SESSION_SECRET,
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
};

const BASE = "https://datatailor.abersonstyle.com";

async function dtFetch(path, cookies) {
  const res = await fetch(BASE + path, {
    headers: {
      Cookie: cookies,
      "User-Agent": "Mozilla/5.0 (compatible; FlowImport/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("datatail HTTP " + res.status + " for " + path);
  return res.text();
}

// Parse a dollar string like "$1,234.56" → number
function parseDollar(s) {
  if (!s) return 0;
  return parseFloat(s.replace(/[$,\s]/g, "")) || 0;
}

// Extract text content from an HTML snippet, stripping tags
function stripTags(s) {
  return (s || "").replace(/<[^>]*>/g, "").trim();
}

// Find all matches of a regex with named groups
function matchAll(str, re) {
  const results = [];
  let m;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(str)) !== null) results.push(m);
  return results;
}

// Parse the vendor index page to get list of {vendorId, deptId, vendorName, deptName}
function parseVendorIndex(html) {
  const vendors = [];
  // Links like /vendor/439/department/7
  const linkRe = /href="\/vendor\/(\d+)\/department\/(\d+)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    vendors.push({
      vendorId: m[1],
      deptId: m[2],
      vendorName: m[3].trim(),
    });
  }
  // Also extract department names from headings like <h2>Accessories</h2> or tabs
  return vendors;
}

// Parse store summary page to extract department rows
function parseStoreSummary(html) {
  const rows = [];
  // Look for table rows with dept name + dollar values
  // Pattern varies — look for rows containing dollar amounts
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = cellRe.exec(m[1])) !== null) cells.push(stripTags(c[1]));
    // A summary row has: deptName, ordered($), received($), sold($), recPct(%), soldPct(%)
    if (cells.length >= 4 && cells[1] && cells[1].startsWith("$")) {
      rows.push({
        name: cells[0],
        ordered: parseDollar(cells[1]),
        received: parseDollar(cells[2]),
        sold: parseDollar(cells[3]),
      });
    }
  }
  return rows;
}

// Parse vendor detail page to extract product rows
function parseVendorDetail(html, vendorId, deptId) {
  // Extract ordered/received/sold totals from the "totals" section
  let ordered = 0, received = 0, sold = 0;
  const totalRe = /Ordered[\s\S]*?\$([\d,]+\.?\d*)/i;
  const tm = totalRe.exec(html);
  if (tm) ordered = parseDollar(tm[1]);
  const recRe = /Received[\s\S]*?\$([\d,]+\.?\d*)/i;
  const rm = recRe.exec(html);
  if (rm) received = parseDollar(rm[1]);
  const soldRe = /Sold[\s\S]*?\$([\d,]+\.?\d*)/i;
  const sm = soldRe.exec(html);
  if (sm) sold = parseDollar(sm[1]);

  // Extract product rows from the items table
  // Columns: Status, Description, Style, Color, Fabric, Size, Cost, Price
  const products = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tMatch;
  while ((tMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tMatch[0];
    if (!tableHtml.includes("Description") && !tableHtml.includes("Style")) continue;
    // Parse header row to determine column order
    const headerRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    const headers = [];
    let hm;
    while ((hm = headerRe.exec(tableHtml)) !== null) headers.push(stripTags(hm[1]).toLowerCase());

    const descIdx   = headers.findIndex(h => h.includes("description"));
    const styleIdx  = headers.findIndex(h => h.includes("style"));
    const colorIdx  = headers.findIndex(h => h.includes("color"));
    const fabricIdx = headers.findIndex(h => h.includes("fabric"));
    const sizeIdx   = headers.findIndex(h => h.includes("size"));
    const costIdx   = headers.findIndex(h => h.includes("cost"));
    const priceIdx  = headers.findIndex(h => h.includes("price"));
    const statusIdx = headers.findIndex(h => h.includes("status"));

    if (descIdx === -1 && styleIdx === -1) continue;

    const rowRe2 = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowM;
    while ((rowM = rowRe2.exec(tableHtml)) !== null) {
      const cells = [];
      const cellRe2 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cm;
      while ((cm = cellRe2.exec(rowM[1])) !== null) cells.push(stripTags(cm[1]));
      if (cells.length < 3) continue;

      const get = (idx) => idx >= 0 && idx < cells.length ? cells[idx] : "";
      const costVal  = parseDollar(get(costIdx));
      const priceVal = parseDollar(get(priceIdx));
      if (!priceVal && !get(descIdx) && !get(styleIdx)) continue;

      // Parse status tally marks from the raw HTML cell
      // Status cell typically contains colored spans or divs
      let statusRaw = "";
      if (statusIdx >= 0) {
        const allCells = [];
        const cellRe3 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let cm3;
        while ((cm3 = cellRe3.exec(rowM[1])) !== null) allCells.push(cm3[1]);
        statusRaw = allCells[statusIdx] || "";
      }

      // Count tally marks by color class (ordered=gray, stock=red, sold=blue, sale=purple, returned=black)
      const countColor = (cls) => (statusRaw.match(new RegExp(cls, "g")) || []).length;

      products.push({
        description: get(descIdx),
        style:       get(styleIdx),
        color:       get(colorIdx),
        fabric:      get(fabricIdx),
        size:        get(sizeIdx),
        cost:        costVal,
        price:       priceVal,
        vendorId,
        deptId,
      });
    }
    break; // only need first matching table
  }

  return { ordered, received, sold, products };
}

// Navigate seasons on the old site (the season is stored in PHP session server-side)
// We need to POST or GET to change the season before scraping
async function selectSeason(targetSeason, cookies) {
  // Try fetching the main page and looking for season nav links
  const html = await dtFetch("/", cookies);
  // Look for season change links/forms — try common patterns
  const seasonLinkRe = /href="([^"]*season[^"]*)"[^>]*>([^<]+)</gi;
  const links = [];
  let m;
  while ((m = seasonLinkRe.exec(html)) !== null) {
    links.push({ url: m[1], label: m[2].trim() });
  }
  return { html, links };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getIronSession(req, res, SESSION_OPTIONS);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { action, phpsessid, rememberme, season } = req.body || {};
  if (!phpsessid && !rememberme) return res.status(400).json({ error: "Provide at least one cookie value" });

  const cookies = [
    phpsessid   ? `PHPSESSID=${phpsessid}`   : "",
    rememberme  ? `REMEMBERME=${rememberme}` : "",
  ].filter(Boolean).join("; ");

  try {
    if (action === "probe") {
      // Just fetch the main page to verify cookies work and detect available seasons
      const html = await dtFetch("/", cookies);
      const loggedIn = html.includes("logout") || html.includes("vendor index") || html.includes("Store Summary");
      if (!loggedIn) return res.json({ ok: false, error: "Cookies appear invalid — not logged in" });

      // Detect current season label
      const seasonRe = /<[^>]*class="[^"]*season[^"]*"[^>]*>([^<]+)<|spring \d{4}|fall \d{4}/gi;
      const seasons = [];
      const rawSeasonRe = /(spring|fall|pre-?spring|pre-?fall)\s+(\d{4})/gi;
      let sm;
      while ((sm = rawSeasonRe.exec(html)) !== null) {
        const label = sm[1] + " " + sm[2];
        if (!seasons.includes(label)) seasons.push(label);
      }

      // Find season navigation links/arrows
      const navLinks = [];
      const arrowRe = /href="([^"]+)"[^>]*>[‹›<>←→]/g;
      let am;
      while ((am = arrowRe.exec(html)) !== null) navLinks.push(am[1]);

      return res.json({ ok: true, seasons, navLinks, snippet: html.slice(0, 2000) });
    }

    if (action === "fetchVendorIndex") {
      const html = await dtFetch("/", cookies);
      const vendors = parseVendorIndex(html);
      return res.json({ ok: true, count: vendors.length, vendors });
    }

    if (action === "fetchVendorDetail") {
      const { vendorId, deptId } = req.body;
      const html = await dtFetch(`/vendor/${vendorId}/department/${deptId}`, cookies);
      const data = parseVendorDetail(html, vendorId, deptId);
      return res.json({ ok: true, ...data });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
