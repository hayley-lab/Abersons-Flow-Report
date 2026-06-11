// Budgeted endpoint that advances the store-wide sales cache one chunk at a time.
// The cron orchestrator drives this to completion before stepping seasons, so
// each season projects sales from the shared aggregate with zero 2.0/sales paging.
//
// Because the cache is version-incremental, normal runs page only new sales;
// only the first-ever build (or an explicit ?sales=1 reset) pays the full
// sales-history page cost — and it pays it ONCE for the whole store, not per season.
//
// Auth matches cron/scan: CRON_SECRET bearer OR iron-session.
import { kv } from "@vercel/kv";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import { makeLsFetch } from "../../../lib/ls-fetch";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { SEASONS } from "../../../lib/seasons";
import { dateMinusDays, seasonSalesFallbackDate } from "../../../lib/flow-math";
import { loadCatalogPriceMap } from "../../../lib/catalog-store";
import { loadSalesStoreMeta, syncSalesStore } from "../../../lib/sales-store";

const CHUNK_MS = 45000;

function currentSeasons() {
  const year = new Date().getFullYear();
  return SEASONS.filter((s) => {
    const m = s.id.match(/\d+$/);
    if (!m) return false;
    const y = parseInt("20" + m[0].slice(-2));
    return y >= year - 1;
  }).map((s) => s.id);
}

// Earliest date_from across all active seasons. Uses each season's consignment
// salesFloorDate (earliest PO date − 30d) when available, else its fallback
// start. The minimum is a safe global floor: paging earlier than a given season
// needs only adds rows for pids that season never projects, never undercounts.
async function computeGlobalSalesDateFrom(kv, seasons) {
  const floors = await Promise.all(
    seasons.map(async (season) => {
      let floor = seasonSalesFallbackDate(season) || "";
      try {
        // The earliest PO date − 30d is a tighter floor than the nominal season
        // start. Prefer the store-wide consignment bucket; fall back to the
        // legacy per-season consignment state.
        const [cb, cs] = await Promise.all([
          kv.get(`scan:consign:season:${season}`),
          kv.get(`scan:consign:state:${season}`),
        ]);
        const src = cb?.salesFloorDate || cs?.salesFloorDate || null;
        const fd = src ? dateMinusDays(src, 30) : null;
        if (fd && (!floor || fd < floor)) floor = fd;
      } catch {
        // ignore — fall back to the season's nominal start
      }
      return floor;
    })
  );
  return floors.filter(Boolean).sort()[0] || "";
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();

  const cronAuth =
    process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuth) {
    const session = await getIronSession(req, res, sessionOptions);
    if (!session.authed) return res.status(401).json({ error: "Unauthorized" });
  }

  let token;
  try {
    token = await getLsToken();
  } catch (e) {
    return res.status(503).json({ error: "LS auth failed: " + e.message });
  }

  const base = lsBase();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const lsFetch = makeLsFetch({ base, headers });
  const deadline = Date.now() + CHUNK_MS;
  const reset = req.query.reset === "1" || req.query.sales === "1";

  try {
    const seasons = currentSeasons();
    const [priceMap, dateFrom] = await Promise.all([
      loadCatalogPriceMap(kv),
      computeGlobalSalesDateFrom(kv, seasons),
    ]);

    const result = await syncSalesStore(kv, lsFetch, { reset, deadline, dateFrom, priceMap });
    const meta = await loadSalesStoreMeta(kv);

    return res.json({
      complete: result.done,
      cacheComplete: result.complete,
      version: result.version,
      pages: result.pages,
      dateFrom,
      metaVersion: meta ? meta.version : null,
      calls: lsFetch.callStats,
    });
  } catch (e) {
    console.error("[sales-cache] sync failed:", e.message);
    return res.status(503).json({ error: e.message });
  }
}
