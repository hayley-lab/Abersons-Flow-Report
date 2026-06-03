// pages/index.js
import { useState, useEffect, useCallback, useRef } from "react";

const fmt = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);

const pctColor = (pct, zero) => {
  if (zero || pct === 0) return { bg: "#f0ede6", color: "#9e9892" };
  if (pct >= 80) return { bg: "#e8f5ee", color: "#2d6a4f" };
  if (pct >= 50) return { bg: "#fef3e2", color: "#92600a" };
  return { bg: "#fdeaea", color: "#8b2020" };
};

const PctBadge = ({ pct, zero }) => {
  const { bg, color } = pctColor(pct, zero);
  return (
    <span style={{ background: bg, color, borderRadius: 20, padding: "2px 8px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {zero ? "0.0%" : `${pct.toFixed(1)}%`}
    </span>
  );
};

const Bar = ({ pct }) => (
  <div style={{ background: "#f0ede6", borderRadius: 3, height: 8, width: 72, overflow: "hidden" }}>
    <div style={{ width: `${Math.min(pct, 100).toFixed(1)}%`, height: "100%", background: "#2d6a4f", borderRadius: 3, transition: "width 0.4s ease" }} />
  </div>
);

const Spinner = ({ label = "Loading…" }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "3rem", color: "#9e9892" }}>
    <div style={{ width: 28, height: 28, border: "2px solid #e2ddd5", borderTopColor: "#3a5a8c", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
    <div style={{ fontSize: 14 }}>{label}</div>
  </div>
);

const ErrBox = ({ msg }) => (
  <div style={{ background: "#fdeaea", border: "1px solid #f0b8b8", borderRadius: 10, padding: "1rem 1.25rem", color: "#8b2020", fontSize: 13, lineHeight: 1.6, marginBottom: "1rem" }}>
    <strong>Error: </strong>{msg}
  </div>
);

const KpiRow = ({ items }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: "1.5rem" }}>
    {items.map(({ label, value, sub }) => (
      <div key={label} style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 10, padding: "0.9rem 1.1rem", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "#9e9892", marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 600, color: "#1a1816", letterSpacing: -0.5 }}>{value}</div>
        {sub && <div style={{ fontSize: 12, color: "#6b6560", marginTop: 3 }}>{sub}</div>}
      </div>
    ))}
  </div>
);

const TableWrap = ({ title, right, children }) => (
  <div style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.9rem 1.1rem 0.7rem", borderBottom: "1px solid #e2ddd5", flexWrap: "wrap", gap: 8 }}>
      <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 17 }}>{title}</div>
      {right}
    </div>
    {children}
  </div>
);

const TH = ({ children, right }) => (
  <th style={{ padding: "8px 12px", textAlign: right ? "right" : "left", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#6b6560", whiteSpace: "nowrap", background: "#f0ede6", borderBottom: "1px solid #e2ddd5", position: "sticky", top: 0, zIndex: 2 }}>
    {children}
  </th>
);

const SortTH = ({ children, col, sort, onSort, right }) => {
  const active = sort.col === col;
  const arrow  = active ? (sort.dir === 1 ? " ↑" : " ↓") : "";
  return (
    <th onClick={() => onSort(col)} style={{ padding: "8px 12px", textAlign: right ? "right" : "left", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: active ? "#3a5a8c" : "#6b6560", whiteSpace: "nowrap", background: "#f0ede6", borderBottom: "1px solid #e2ddd5", position: "sticky", top: 0, zIndex: 2, cursor: "pointer", userSelect: "none" }}>
      {children}{arrow}
    </th>
  );
};

const TD = ({ children, right, mono, style: extraStyle }) => (
  <td style={{ padding: "9px 12px", textAlign: right ? "right" : "left", fontVariantNumeric: right ? "tabular-nums" : "normal", fontFamily: mono ? "monospace" : "inherit", fontSize: mono ? 12 : 13, color: mono ? "#6b6560" : "#1a1816", verticalAlign: "middle", ...extraStyle }}>
    {children}
  </td>
);

import { SEASONS } from "../lib/seasons";


// ── LS API proxy helper (still used for per-product fetches in vendor drilldown)

async function apiFetch(path, attempt) {
  if (!attempt) attempt = 0;
  var res;
  try {
    res = await fetch("/api/ls/" + path);
  } catch (netErr) {
    if (attempt < 4) {
      await new Promise(function(r) { setTimeout(r, 1500 * (attempt + 1)); });
      return apiFetch(path, attempt + 1);
    }
    throw netErr;
  }
  if (res.status === 429 && attempt < 6) {
    await new Promise(function(r) { setTimeout(r, 3000 * Math.pow(2, attempt)); });
    return apiFetch(path, attempt + 1);
  }
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    throw new Error(err.message || err.error || "HTTP " + res.status);
  }
  try {
    return await res.json();
  } catch (parseErr) {
    if (attempt < 4) {
      await new Promise(function(r) { setTimeout(r, 1500 * (attempt + 1)); });
      return apiFetch(path, attempt + 1);
    }
    throw parseErr;
  }
}

async function withConcurrency(tasks, limit) {
  var results = new Array(tasks.length).fill(null);
  var nextIdx = 0;
  async function worker() {
    while (true) {
      var i = nextIdx++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]();
    }
  }
  var workers = [];
  for (var w = 0; w < Math.min(limit, tasks.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ── main component ────────────────────────────────────────────────────────────

export default function FlowReport() {
  const [authed, setAuthed]       = useState(null);
  const [password, setPassword]   = useState("");
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const [screen, setScreen]       = useState("summary");
  const [season, setSeason]       = useState("prefall26");

  const [summaryRows, setSummaryRows]   = useState([]);
  const [scanData, setScanData]         = useState(null);   // full KV data for current season
  const [dataLoading, setDataLoading]   = useState(false);
  const [dataError, setDataError]       = useState(null);
  const [dataTs, setDataTs]             = useState(null);   // timestamp of last successful scan
  const [hasOverride, setHasOverride]   = useState(false);  // season uses imported override data

  const [scanning, setScanning]         = useState(false);
  const [scanProgress, setScanProgress] = useState("");
  const [scanError, setScanError]       = useState(null);
  const scanAbort = useRef(false);

  const [currentDept, setCurrentDept]   = useState(null);
  const [vendorRows, setVendorRows]     = useState([]);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorError, setVendorError]   = useState(null);

  const [currentVendor, setCurrentVendor] = useState(null);
  const [productRows, setProductRows]   = useState([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productError, setProductError] = useState(null);
  const [productSort, setProductSort]   = useState({ col: "name", dir: 1 });
  const [vendorSort,  setVendorSort]    = useState({ col: "name", dir: 1 });
  const [summarySort, setSummarySort]  = useState({ col: "name", dir: 1 });

  // ── auth check ─────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/auth/session")
      .then(r => r.json())
      .then(d => setAuthed(d.authenticated === true))
      .catch(() => setAuthed(false));
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        setAuthed(true);
      } else {
        const d = await r.json().catch(() => ({}));
        setLoginError(d.error || "Incorrect password");
      }
    } catch {
      setLoginError("Network error — please try again.");
    }
    setLoginLoading(false);
  }

  // ── load data from KV ──────────────────────────────────────────────────────

  const loadData = useCallback(async (seasonId) => {
    setDataLoading(true);
    setDataError(null);
    try {
      const r = await fetch(`/api/scan/data?season=${encodeURIComponent(seasonId)}`);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        if (r.status === 401) { setAuthed(false); return; }
        throw new Error(d.error || "HTTP " + r.status);
      }
      const { data, hasOverride: ov } = await r.json();
      setHasOverride(!!ov);
      if (data) {
        setScanData(data);
        setSummaryRows(data.summaryRows || []);
        setDataTs(data.ts);
      } else {
        setScanData(null);
        setSummaryRows([]);
        setDataTs(null);
      }
    } catch (e) {
      setDataError(e.message);
    }
    setDataLoading(false);
  }, []);

  useEffect(() => {
    if (authed === true) loadData(season);
  }, [authed, loadData, season]);

  // Reload after a completed scan
  const reloadAfterScan = useCallback(() => loadData(season), [loadData, season]);

  // ── server-side refresh scan ───────────────────────────────────────────────

  const runScan = useCallback(async (restart) => {
    setScanError(null);
    setScanning(true);
    setScanProgress("Starting scan…");
    scanAbort.current = false;

    try {
      let phase = "init";
      while (phase !== "done" && phase !== "error" && !scanAbort.current) {
        const url = `/api/scan/step?season=${encodeURIComponent(season)}` +
                    (restart ? "&restart=1" : "");
        restart = false; // only first call gets restart flag
        const r = await fetch(url, { method: "POST" });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          if (r.status === 401) { setAuthed(false); break; }
          throw new Error(d.error || "HTTP " + r.status);
        }
        const state = await r.json();
        phase = state.phase;
        setScanProgress(state.progress || "…");
        if (phase === "error") {
          setScanError(state.error || "Scan failed");
          break;
        }
        if (phase === "done") {
          await reloadAfterScan();
          break;
        }
        // Small pause between chunks so we don't instantly re-hammer the server
        await new Promise(res => setTimeout(res, 200));
      }
    } catch (e) {
      setScanError(e.message);
    }
    setScanning(false);
  }, [season, reloadAfterScan]);

  // ── department drilldown ───────────────────────────────────────────────────

  const openDept = useCallback(function(dept) {
    setCurrentDept(dept);
    setVendorRows([]);
    setVendorError(null);
    setVendorLoading(true);
    setScreen("vendors");

    try {
      const vendors = (scanData && scanData.deptVendors && scanData.deptVendors[dept.id]) || [];
      setVendorRows(vendors.slice().sort((a, b) => b.ordered - a.ordered));
    } catch (e) {
      setVendorError(e.message);
    }
    setVendorLoading(false);
  }, [scanData]);

  // ── vendor drilldown ───────────────────────────────────────────────────────

  const openVendor = useCallback(async function(vendor) {
    setCurrentVendor(vendor);
    setProductRows([]);
    setProductLoading(true);
    setProductError(null);
    setScreen("products");

    try {
      // For historical import seasons, products are stored in the vendor object directly.
      // If a sync has run, use skuToPid to pull live stats + inventory from LS.
      if (vendor.overrideProducts) {
        const skuToPid     = (scanData && scanData.skuToPid)     || {};
        const productStats = (scanData && scanData.productStats) || {};

        // Collect unique LS PIDs for these products
        const pidSet = new Set(
          vendor.overrideProducts.map(p => skuToPid[(p.style || "").toLowerCase().trim()]).filter(Boolean)
        );

        // Fetch current inventory for all matched PIDs concurrently
        const invMap = {};
        if (pidSet.size > 0) {
          await withConcurrency(
            Array.from(pidSet).map(pid => async function() {
              const inv = await apiFetch("2.0/products/" + pid + "/inventory").catch(() => null);
              if (inv) {
                const d = inv.data || inv;
                invMap[pid] = Array.isArray(d)
                  ? d.reduce(function(s, r) { return s + (r.current_amount || 0); }, 0)
                  : (d.current_amount != null ? d.current_amount : (d.count != null ? d.count : null));
              }
            }),
            8
          );
        }

        setProductRows(vendor.overrideProducts.map(function(p) {
          const pid    = skuToPid[(p.style || "").toLowerCase().trim()];
          const stats  = pid ? (productStats[pid] || {}) : {};
          const onHand = pid && invMap[pid] != null ? invMap[pid] : (p.qtyStock || 0);
          return {
            name:       p.description || "",
            sku:        p.style       || "",
            variant:    [p.color, p.fabric, p.size].filter(Boolean).join(" / "),
            cost:       p.cost        || 0,
            price:      p.price       || 0,
            qtyOrdered: p.qtyOrdered  || 0,
            onHand,
            sold:       stats.sold     != null ? stats.sold     : (p.qtySold     || 0),
            onSale:     stats.onSale   != null ? stats.onSale   : (p.qtySale     || 0),
            returned:   stats.returned != null ? stats.returned : (p.qtyReturned || 0),
          };
        }));
        setProductLoading(false);
        return;
      }

      // Find this vendor's product IDs in this dept from the pre-scanned data
      const seasonPids      = (scanData && scanData.seasonPids)      || [];
      const pidToType       = (scanData && scanData.pidToType)       || {};
      const pidToSupplier   = (scanData && scanData.pidToSupplier)   || {};
      const productStats    = (scanData && scanData.productStats)    || {};
      const pidToQtyOrdered = (scanData && scanData.pidToQtyOrdered) || {};

      const targetIds = seasonPids.filter(function(id) {
        const sup = pidToSupplier[id];
        const typ = pidToType[id];
        return sup && (sup.i || sup.id) === vendor.id &&
               (typ === currentDept.id || typ === "__none__");
      });

      // Fetch full product details (name, SKU, inventory) from LS
      var products = [];
      if (targetIds.length > 0) {
        var fetched = await withConcurrency(
          targetIds.map(function(id) {
            return async function() {
              var [pd, inv] = await Promise.all([
                apiFetch("2.0/products/" + id),
                apiFetch("2.0/products/" + id + "/inventory").catch(() => null),
              ]);
              var p = pd.data || pd;
              if (p && inv) {
                var invData = inv.data || inv;
                p._onHand = Array.isArray(invData)
                  ? invData.reduce(function(s, r) { return s + (r.current_amount || 0); }, 0)
                  : (invData.current_amount ?? invData.count ?? null);
              }
              return p;
            };
          }),
          8
        );
        products = fetched.filter(Boolean);
      }

      setProductRows(products.map(function(p) {
        const stats = productStats[p.id] || {};
        return {
          name:     (p.description ? p.description.replace(/<[^>]*>/g, "").trim() : "") || p.name,
          sku:      p.sku || "",
          variant:  p.variant_option_one_value || p.variant_name || "",
          cost:     parseFloat(p.supply_price        || 0),
          price:    parseFloat(p.price_excluding_tax || 0),
          qtyOrdered: pidToQtyOrdered[p.id] || 0,
          onHand:     p._onHand != null ? p._onHand : (p.inventory && p.inventory.count != null) ? p.inventory.count : (p.inventory_count || 0),
          sold:       stats.sold     || 0,
          onSale:     stats.onSale   || 0,
          returned:   stats.returned || 0,
        };
      }));
    } catch (e) {
      setProductError(e.message);
    }
    setProductLoading(false);
  }, [currentDept, scanData]);

  // ── vendor all-departments drilldown (from summary vendor list) ──────────────

  const openVendorProducts = useCallback(async function(vendorInfo) {
    setCurrentVendor({ ...vendorInfo, allDepts: true });
    setCurrentDept(null);
    setProductRows([]);
    setProductLoading(true);
    setProductError(null);
    setScreen("products");

    try {
      const skuToPid     = (scanData && scanData.skuToPid)     || {};
      const productStats = (scanData && scanData.productStats) || {};
      const deptVendors  = (scanData && scanData.deptVendors)  || {};

      // Collect all vendor entries across departments matching this vendor
      const normVendorName = (vendorInfo.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const allEntries = [];
      Object.values(deptVendors).forEach(function(vendors) {
        vendors.forEach(function(v) {
          const vNorm = (v.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          if (String(v.id) === String(vendorInfo.id) || vNorm === normVendorName) {
            allEntries.push(v);
          }
        });
      });

      // Override products path (historical seasons)
      const overrideProducts = allEntries.flatMap(function(v) { return v.overrideProducts || []; });
      if (overrideProducts.length > 0) {
        const pidSet = new Set(
          overrideProducts.map(p => skuToPid[(p.style || "").toLowerCase().trim()]).filter(Boolean)
        );
        const invMap = {};
        if (pidSet.size > 0) {
          await withConcurrency(Array.from(pidSet).map(pid => async function() {
            const inv = await apiFetch("2.0/products/" + pid + "/inventory").catch(() => null);
            if (inv) {
              const d = inv.data || inv;
              invMap[pid] = Array.isArray(d)
                ? d.reduce(function(s, r) { return s + (r.current_amount || 0); }, 0)
                : (d.current_amount != null ? d.current_amount : (d.count != null ? d.count : null));
            }
          }), 8);
        }
        setProductRows(overrideProducts.map(function(p) {
          const pid    = skuToPid[(p.style || "").toLowerCase().trim()];
          const stats  = pid ? (productStats[pid] || {}) : {};
          const onHand = pid && invMap[pid] != null ? invMap[pid] : (p.qtyStock || 0);
          return {
            name: p.description || "", sku: p.style || "",
            variant:    [p.color, p.fabric, p.size].filter(Boolean).join(" / "),
            cost: p.cost || 0, price: p.price || 0,
            qtyOrdered: p.qtyOrdered || 0, onHand,
            sold:     stats.sold     != null ? stats.sold     : (p.qtySold     || 0),
            onSale:   stats.onSale   != null ? stats.onSale   : (p.qtySale     || 0),
            returned: stats.returned != null ? stats.returned : (p.qtyReturned || 0),
          };
        }));
        setProductLoading(false);
        return;
      }

      // LS scan path — filter seasonPids by vendor only (no dept filter)
      const seasonPids      = (scanData && scanData.seasonPids)      || [];
      const pidToType       = (scanData && scanData.pidToType)       || {};
      const pidToSupplier   = (scanData && scanData.pidToSupplier)   || {};
      const pidToQtyOrdered = (scanData && scanData.pidToQtyOrdered) || {};

      const targetIds = seasonPids.filter(function(id) {
        const sup = pidToSupplier[id];
        return sup && (sup.i || sup.id) === vendorInfo.id;
      });

      var products = [];
      if (targetIds.length > 0) {
        var fetched = await withConcurrency(targetIds.map(function(id) {
          return async function() {
            var [pd, inv] = await Promise.all([
              apiFetch("2.0/products/" + id),
              apiFetch("2.0/products/" + id + "/inventory").catch(() => null),
            ]);
            var p = pd.data || pd;
            if (p && inv) {
              var invData = inv.data || inv;
              p._onHand = Array.isArray(invData)
                ? invData.reduce(function(s, r) { return s + (r.current_amount || 0); }, 0)
                : (invData.current_amount ?? invData.count ?? null);
            }
            return p;
          };
        }), 8);
        products = fetched.filter(Boolean);
      }

      setProductRows(products.map(function(p) {
        const stats = productStats[p.id] || {};
        return {
          name:     (p.description ? p.description.replace(/<[^>]*>/g, "").trim() : "") || p.name,
          sku:      p.sku || "",
          variant:  p.variant_option_one_value || p.variant_name || "",
          cost:     parseFloat(p.supply_price        || 0),
          price:    parseFloat(p.price_excluding_tax || 0),
          qtyOrdered: pidToQtyOrdered[p.id] || 0,
          onHand:     p._onHand != null ? p._onHand : (p.inventory_count || 0),
          sold:       stats.sold     || 0,
          onSale:     stats.onSale   || 0,
          returned:   stats.returned || 0,
        };
      }));
    } catch (e) {
      setProductError(e.message);
    }
    setProductLoading(false);
  }, [scanData]);

  // Re-run openVendor if scanData refreshes while we're already on the products screen
  const prevScanDataRef = useRef(null);
  useEffect(() => {
    if (screen === "products" && currentVendor && scanData && scanData !== prevScanDataRef.current) {
      prevScanDataRef.current = scanData;
      openVendor(currentVendor);
    }
  }, [screen, currentVendor, scanData, openVendor]);

  const totalOrdered      = summaryRows.reduce((a, r) => a + r.ordered,             0);
  const totalOrderedCost  = summaryRows.reduce((a, r) => a + (r.orderedCost || 0), 0);
  const totalReceived     = summaryRows.reduce((a, r) => a + r.received,            0);
  const totalReceivedCost = summaryRows.reduce((a, r) => a + (r.cost || 0),        0);
  const totalSold         = summaryRows.reduce((a, r) => a + r.sold,               0);
  const totalRecPct    = totalOrdered  > 0 ? (totalReceived / totalOrdered)  * 100 : 0;
  const totalSoldPct   = totalReceived > 0 ? (totalSold     / totalReceived) * 100 : 0;
  const vTotalOrdered      = vendorRows.reduce((a, r) => a + r.ordered,              0);
  const vTotalOrderedCost  = vendorRows.reduce((a, r) => a + (r.orderedCost || 0),  0);
  const vTotalReceived     = vendorRows.reduce((a, r) => a + r.received,             0);
  const vTotalReceivedCost = vendorRows.reduce((a, r) => a + (r.cost || 0),         0);
  const vTotalSold         = vendorRows.reduce((a, r) => a + r.sold,                0);

  const BUCKET_COLORS = { sold: "#4a7ab5", sale: "#6c3483", stock: "#c0392b", ordered: "#aaa", returned: "#000000" };
  const BUCKET_LABELS = { ordered: "ordered", stock: "in stock", sold: "sold", sale: "on sale", returned: "returned" };
  const productBuckets = (function() {
    const b = { ordered: {n:0,v:0}, stock: {n:0,v:0}, sold: {n:0,v:0}, sale: {n:0,v:0}, returned: {n:0,v:0} };
    productRows.forEach(function(p) {
      var price = p.price || 0;
      var soldFull = Math.max(0, (p.sold || 0) - (p.onSale || 0));
      var notReceived = Math.max(0, (p.qtyOrdered || 0) - (p.onHand || 0) - (p.sold || 0) - (p.returned || 0));
      if (soldFull   > 0) { b.sold.n++;     b.sold.v     += price; }
      if (p.onSale   > 0) { b.sale.n++;     b.sale.v     += price; }
      if (p.onHand   > 0) { b.stock.n++;    b.stock.v    += price; }
      if (p.returned > 0) { b.returned.n++; b.returned.v += price; }
      if (notReceived> 0) { b.ordered.n++;  b.ordered.v  += price; }
    });
    return b;
  })();

  var seasonLabel = "";
  for (var sIdx = 0; sIdx < SEASONS.length; sIdx++) {
    if (SEASONS[sIdx].id === season) { seasonLabel = SEASONS[sIdx].name; break; }
  }
  if (!seasonLabel) seasonLabel = season;

  // ── styles ─────────────────────────────────────────────────────────────────

  const s = {
    app:        { fontFamily: "'DM Sans',sans-serif", background: "#f7f5f0", minHeight: "100vh", fontSize: 14 },
    header:     { background: "#fff", borderBottom: "1px solid #e2ddd5", padding: "0 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
    logo:       { fontFamily: "'DM Serif Display',serif", fontSize: 22, color: "#1a1816", letterSpacing: -0.5 },
    nav:        { display: "flex", gap: 4 },
    navBtn:     function(active) { return { background: active ? "#e8eef7" : "none", border: "none", padding: "6px 13px", borderRadius: 6, fontSize: 13, color: active ? "#3a5a8c" : "#6b6560", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }; },
    main:       { padding: "1.75rem 1.5rem", maxWidth: 1200, margin: "0 auto" },
    seasonPill: { display: "flex", alignItems: "center", gap: 6, background: "#f0ede6", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 10px", fontSize: 13, fontWeight: 500 },
    tableRow:   function(clickable, zero) { return { borderBottom: "1px solid #e2ddd5", cursor: clickable && !zero ? "pointer" : "default", opacity: zero ? 0.45 : 1, transition: "background 0.1s" }; },
    backBtn:    { background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, textDecoration: "underline", textUnderlineOffset: 2, padding: 0, marginBottom: "0.9rem" },
    demoBadge:  { background: "#fef3e2", color: "#92600a", border: "1px solid #f5d9a0", borderRadius: 20, fontSize: 11, fontWeight: 600, padding: "3px 10px", letterSpacing: "0.04em" },
    statusDots: function(p) {
      var C = { sold: "#4a7ab5", sale: "#6c3483", stock: "#c0392b", ordered: "#aaa", returned: "#000000" };
      var notReceived = Math.max(0, (p.qtyOrdered || 0) - (p.onHand || 0) - (p.sold || 0) - (p.returned || 0));
      var soldFull = Math.max(0, (p.sold || 0) - (p.onSale || 0));
      var marks = [
        { color: C.sold,     n: soldFull },
        { color: C.sale,     n: p.onSale    || 0 },
        { color: C.stock,    n: p.onHand    || 0 },
        { color: C.returned, n: p.returned  || 0 },
        { color: C.ordered,  n: notReceived },
      ];
      var dots = [];
      marks.forEach(function(m) {
        for (var i = 0; i < m.n; i++) {
          dots.push(m.color);
        }
      });
      return dots;
    },
  };

  const fontLink = "@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500;600&display=swap'); @keyframes spin{to{transform:rotate(360deg)}} tbody tr:hover{background:#f0f5fb!important}";

  // ── login screen ────────────────────────────────────────────────────────────

  if (authed === null) return (
    <div style={s.app}><style>{fontLink}</style>
      <header style={s.header}><div style={s.logo}>abersons</div></header>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 56px)" }}>
        <Spinner label="Checking login…" />
      </div>
    </div>
  );

  if (authed === false) return (
    <div style={s.app}><style>{fontLink}</style>
      <header style={s.header}><div style={s.logo}>abersons</div></header>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 56px)", gap: 16 }}>
        <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 26, color: "#1a1816" }}>Flow Report</div>
        <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 10, width: 280 }}>
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #e2ddd5", fontSize: 14, fontFamily: "'DM Sans',sans-serif", outline: "none" }}
          />
          {loginError && <div style={{ color: "#8b2020", fontSize: 13 }}>{loginError}</div>}
          <button type="submit" disabled={loginLoading}
            style={{ background: "#3a5a8c", color: "#fff", padding: "10px 0", borderRadius: 8, border: "none", fontSize: 14, fontWeight: 500, cursor: loginLoading ? "default" : "pointer", opacity: loginLoading ? 0.7 : 1, fontFamily: "'DM Sans',sans-serif" }}>
            {loginLoading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );

  // ── scan-in-progress banner ────────────────────────────────────────────────

  const ScanBanner = scanning ? (
    <div style={{ background: "#e8eef7", border: "1px solid #b8cce4", borderRadius: 8, padding: "10px 16px", marginBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 16, height: 16, border: "2px solid #b8cce4", borderTopColor: "#3a5a8c", borderRadius: "50%", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: "#3a5a8c" }}>{scanProgress}</span>
      </div>
      <button onClick={() => { scanAbort.current = true; setScanning(false); }}
        style={{ background: "none", border: "none", fontSize: 12, color: "#6b6560", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
        cancel
      </button>
    </div>
  ) : (scanError && !hasOverride) ? (
    <div style={{ background: "#fdeaea", border: "1px solid #f0b8b8", borderRadius: 8, padding: "10px 16px", marginBottom: "1rem", fontSize: 13, color: "#8b2020" }}>
      Scan failed: {scanError}
    </div>
  ) : null;

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div style={s.app}>
      <style>{fontLink}</style>

      <header style={s.header}>
        <div style={s.logo}>abersons</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={s.seasonPill}>
            {(function() {
              var idx = SEASONS.findIndex(function(s2) { return s2.id === season; });
              var prev = SEASONS[idx - 1];
              var next = SEASONS[idx + 1];
              var btnStyle = function(enabled) { return { background: "none", border: "none", padding: "0 3px", fontSize: 20, lineHeight: 1, color: enabled ? "#3a5a8c" : "#ccc", cursor: enabled ? "pointer" : "default", fontFamily: "'DM Sans',sans-serif" }; };
              return (<>
                <button style={btnStyle(!!prev)} disabled={!prev} onClick={function() { if (prev) { setSeason(prev.id); setScreen("summary"); } }}>‹</button>
                <select value={season} onChange={function(e) { setSeason(e.target.value); setScreen("summary"); }}
                  style={{ background: "none", border: "none", fontFamily: "'DM Sans',sans-serif", fontSize: 12, fontWeight: 500, color: "#1a1816", cursor: "pointer", outline: "none" }}>
                  {SEASONS.map(function(s2) { return <option key={s2.id} value={s2.id}>{s2.name}</option>; })}
                </select>
                <button style={btnStyle(!!next)} disabled={!next} onClick={function() { if (next) { setSeason(next.id); setScreen("summary"); } }}>›</button>
              </>);
            })()}
          </div>
          <button onClick={function() { fetch("/api/auth/logout").then(function() { setAuthed(false); }); }}
            style={{ background: "none", border: "none", padding: "5px 8px", fontSize: 12, color: "#9e9892", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            logout
          </button>
        </div>
      </header>

      <div style={s.main}>

        {/* ── SUMMARY ── */}
        {screen === "summary" && (
          <>
            {ScanBanner}
            {dataLoading && <Spinner label={"Loading " + seasonLabel + " data…"} />}
            {dataError && <ErrBox msg={dataError} />}
            {!dataLoading && (
              <>
                <KpiRow items={[
                  { label: "Ordered (retail)",  value: fmt(totalOrdered) },
                  { label: "Ordered (cost)",    value: fmt(totalOrderedCost) },
                  { label: "Received (retail)", value: fmt(totalReceived),     sub: totalRecPct.toFixed(1)  + "% of ordered" },
                  { label: "Received (cost)",   value: fmt(totalReceivedCost) },
                  { label: "Sold (retail)",     value: fmt(totalSold),         sub: totalSoldPct.toFixed(1) + "% of received" },
                  { label: "Departments",       value: summaryRows.filter(r => r.ordered > 0 || r.sold > 0).length },
                ]} />
                <TableWrap title={"Store Summary — " + seasonLabel}
                  right={
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {dataTs && !scanning && (
                        <span style={{ fontSize: 11, color: "#9e9892" }}>
                          updated {new Date(dataTs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </span>
                      )}
                      <button
                        onClick={() => { if (!scanning) runScan(true); }}
                        disabled={scanning}
                        style={{ background: "none", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 11px", fontSize: 12, fontWeight: 500, color: scanning ? "#b0aba5" : "#6b6560", cursor: scanning ? "default" : "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                        {scanning ? "↺ Scanning…" : hasOverride ? "↺ Sync from LS" : "↺ Refresh"}
                      </button>
                    </div>
                  }>
                  {summaryRows.length === 0 && !scanning ? (
                    <div style={{ padding: "2.5rem", textAlign: "center", color: "#9e9892", fontSize: 13 }}>
                      {hasOverride ? <>Historical data imported. Click <strong>↺ Sync from LS</strong> to pull live sales &amp; stock.</> : <>No scan data yet for {seasonLabel}. Click <strong>↺ Refresh</strong> to run the first scan.</>}
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <TH>Sold %</TH>
                          <SortTH col="name"        sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}}>Department</SortTH>
                          <SortTH col="ordered"     sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}} right>Ordered (retail)</SortTH>
                          <SortTH col="orderedCost" sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}} right>Ordered (cost)</SortTH>
                          <SortTH col="received"    sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}} right>Received (retail)</SortTH>
                          <SortTH col="cost"        sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}} right>Received (cost)</SortTH>
                          <SortTH col="sold"        sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}} right>Sold (retail)</SortTH>
                          <SortTH col="recPct"      sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}} right>Received %</SortTH>
                          <SortTH col="soldPct"     sort={summarySort} onSort={function(c){setSummarySort(function(p){return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1};});}} right>Sold %</SortTH>
                        </tr>
                      </thead>
                      <tbody>
                        {summaryRows.filter(r => r.ordered > 0 || r.received > 0 || r.sold > 0).map(function(r) {
                          var recPct  = r.ordered  > 0 ? (r.received / r.ordered)  * 100 : 0;
                          var soldPct = r.received > 0 ? (r.sold     / r.received) * 100 : 0;
                          return { ...r, recPct, soldPct };
                        }).sort(function(a, b) {
                          var col = summarySort.col;
                          var av = col === "name" ? (a.name||"").toLowerCase() : (a[col] || 0);
                          var bv = col === "name" ? (b.name||"").toLowerCase() : (b[col] || 0);
                          return av < bv ? -summarySort.dir : av > bv ? summarySort.dir : 0;
                        }).map(function(r) {
                          var zero = r.ordered === 0 && r.sold === 0;
                          return (
                            <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={function() { if (!zero) openDept(r); }}>
                              <TD><Bar pct={r.soldPct} /></TD>
                              <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                              <TD right>{r.ordered     > 0 ? fmt(r.ordered)     : ""}</TD>
                              <TD right>{r.orderedCost > 0 ? fmt(r.orderedCost) : ""}</TD>
                              <TD right>{r.received    > 0 ? fmt(r.received)    : ""}</TD>
                              <TD right>{r.cost        > 0 ? fmt(r.cost)        : ""}</TD>
                              <TD right>{r.sold        > 0 ? fmt(r.sold)        : ""}</TD>
                              <TD right><PctBadge pct={r.recPct}  zero={zero} /></TD>
                              <TD right><PctBadge pct={r.soldPct} zero={zero} /></TD>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  )}
                </TableWrap>

                {/* ── Vendor Index ── */}
                {(function() {
                  if (!scanData || !scanData.deptVendors) return null;
                  // Build map: vendorId → {name, bestDept (highest ordered)}
                  var vendorMap = {};
                  var deptVendors = scanData.deptVendors;
                  Object.keys(deptVendors).forEach(function(deptId) {
                    var dept = summaryRows.find(function(r) { return String(r.id) === String(deptId); });
                    deptVendors[deptId].forEach(function(v) {
                      if (!v.name) return;
                      if (!vendorMap[v.id]) {
                        vendorMap[v.id] = { id: v.id, name: v.name, bestDept: dept, bestOrdered: v.ordered || 0 };
                      } else if ((v.ordered || 0) > vendorMap[v.id].bestOrdered) {
                        vendorMap[v.id].bestDept = dept;
                        vendorMap[v.id].bestOrdered = v.ordered || 0;
                      }
                    });
                  });
                  var allVendors = Object.values(vendorMap).sort(function(a, b) {
                    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
                  });
                  if (allVendors.length === 0) return null;
                  // Group by first letter
                  var groups = {};
                  allVendors.forEach(function(v) {
                    var letter = v.name[0].toUpperCase();
                    if (!/[A-Z]/.test(letter)) letter = "#";
                    if (!groups[letter]) groups[letter] = [];
                    groups[letter].push(v);
                  });
                  var letters = Object.keys(groups).sort(function(a, b) {
                    if (a === "#") return -1;
                    if (b === "#") return 1;
                    return a < b ? -1 : 1;
                  });
                  return (
                    <div style={{ marginTop: "1.5rem", background: "#fff", border: "1px solid #e2ddd5", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", padding: "1rem 1.25rem" }}>
                      <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 17, marginBottom: "1rem" }}>Vendor List</div>
                      {letters.map(function(letter) {
                        return (
                          <div key={letter} style={{ marginBottom: "0.75rem", display: "flex", gap: 8, alignItems: "baseline" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#9e9892", width: 18, flexShrink: 0 }}>{letter}</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 0" }}>
                              {groups[letter].map(function(v, i) {
                                return (
                                  <span key={v.id}>
                                    <button
                                      onClick={function() { openVendorProducts(v); }}
                                      style={{ background: "none", border: "none", padding: "0 4px", fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: v.bestDept ? "#3a5a8c" : "#9e9892", cursor: v.bestDept ? "pointer" : "default", textDecoration: v.bestDept ? "underline" : "none", textUnderlineOffset: 2 }}>
                                      {v.name}
                                    </button>
                                    {i < groups[letter].length - 1 && <span style={{ color: "#d0ccc5", fontSize: 11 }}>|</span>}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </>
            )}
          </>
        )}

        {/* ── VENDORS ── */}
        {screen === "vendors" && (
          <>
            <button style={s.backBtn} onClick={function() { setScreen("summary"); }}>← Store Summary</button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1rem" }}>
              <button onClick={function() { setScreen("summary"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>Store Summary</button>
              {" › "}<span style={{ color: "#1a1816", fontWeight: 500 }}>{currentDept ? currentDept.name : ""}</span>
            </div>
            {/* Department jump pills */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: "1.25rem" }}>
              {summaryRows.filter(function(r) { return r.ordered > 0 || r.sold > 0; }).sort(function(a, b) { return (a.name||"").toLowerCase() < (b.name||"").toLowerCase() ? -1 : 1; }).map(function(r) {
                var active = currentDept && String(r.id) === String(currentDept.id);
                return (
                  <button key={r.id} onClick={function() { if (!active) openDept(r); }}
                    style={{ background: active ? "#3a5a8c" : "#fff", color: active ? "#fff" : "#3a5a8c", border: "1px solid " + (active ? "#3a5a8c" : "#b8cce4"), borderRadius: 20, padding: "4px 13px", fontSize: 12, fontWeight: active ? 600 : 400, fontFamily: "'DM Sans',sans-serif", cursor: active ? "default" : "pointer" }}>
                    {r.name}
                  </button>
                );
              })}
            </div>
            {vendorLoading && <Spinner label="Loading vendors…" />}
            {vendorError && <ErrBox msg={vendorError} />}
            {!vendorLoading && (
              <>
                <KpiRow items={[
                  { label: "Ordered (retail)", value: fmt(vTotalOrdered) },
                  { label: "Ordered (cost)",   value: fmt(vTotalOrderedCost) },
                  { label: "Received (retail)",value: fmt(vTotalReceived),     sub: vTotalOrdered > 0 ? ((vTotalReceived / vTotalOrdered) * 100).toFixed(1) + "%" : "—" },
                  { label: "Received (cost)",  value: fmt(vTotalReceivedCost) },
                  { label: "Sold (retail)",    value: fmt(vTotalSold),         sub: vTotalReceived > 0 ? ((vTotalSold / vTotalReceived) * 100).toFixed(1) + "%" : "—" },
                  { label: "Vendors",          value: vendorRows.filter(r => r.ordered > 0 || r.sold > 0).length },
                ]} />
                <TableWrap title={(currentDept ? currentDept.name : "") + " — by Vendor"}>
                  <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <TH>Sold %</TH>
                        <SortTH col="name"         sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }}>Vendor</SortTH>
                        <SortTH col="ordered"      sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }} right>Ordered (retail)</SortTH>
                        <SortTH col="orderedCost"  sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }} right>Ordered (cost)</SortTH>
                        <SortTH col="received"     sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }} right>Received (retail)</SortTH>
                        <SortTH col="cost"         sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }} right>Received (cost)</SortTH>
                        <SortTH col="sold"         sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }} right>Sold (retail)</SortTH>
                        <SortTH col="recPct"       sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }} right>Received %</SortTH>
                        <SortTH col="soldPct"      sort={vendorSort} onSort={function(c) { setVendorSort(function(p) { return p.col===c?{col:c,dir:p.dir*-1}:{col:c,dir:-1}; }); }} right>Sold %</SortTH>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorRows.map(function(r) {
                        var recPct  = r.ordered  > 0 ? (r.received / r.ordered)  * 100 : 0;
                        var soldPct = r.received > 0 ? (r.sold     / r.received) * 100 : 0;
                        return { ...r, recPct, soldPct };
                      }).sort(function(a, b) {
                        var col = vendorSort.col;
                        var av = col === "name" ? (a.name||"").toLowerCase() : (a[col] || 0);
                        var bv = col === "name" ? (b.name||"").toLowerCase() : (b[col] || 0);
                        return av < bv ? -vendorSort.dir : av > bv ? vendorSort.dir : 0;
                      }).map(function(r) {
                        var zero = r.ordered === 0 && r.sold === 0;
                        return (
                          <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={function() { if (!zero) openVendor(r); }}>
                            <TD><Bar pct={r.soldPct} /></TD>
                            <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                            <TD right>{r.ordered  > 0 ? fmt(r.ordered)              : ""}</TD>
                            <TD right>{r.orderedCost > 0 ? fmt(r.orderedCost)       : ""}</TD>
                            <TD right>{r.received > 0 ? fmt(r.received)             : ""}</TD>
                            <TD right>{r.cost     > 0 ? fmt(r.cost)                 : ""}</TD>
                            <TD right>{r.sold     > 0 ? fmt(r.sold)                 : ""}</TD>
                            <TD right><PctBadge pct={r.recPct}  zero={zero} /></TD>
                            <TD right><PctBadge pct={r.soldPct} zero={zero} /></TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                </TableWrap>
              </>
            )}
          </>
        )}

        {/* ── PRODUCTS ── */}
        {screen === "products" && (
          <>
            <button style={s.backBtn} onClick={function() { setScreen(currentVendor && currentVendor.allDepts ? "summary" : "vendors"); }}>
              ← {currentVendor && currentVendor.allDepts ? "Store Summary" : (currentDept ? currentDept.name : "")}
            </button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button onClick={function() { setScreen("summary"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>Store Summary</button>
              {currentVendor && !currentVendor.allDepts && (<>
                {" › "}
                <button onClick={function() { setScreen("vendors"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>{currentDept ? currentDept.name : ""}</button>
              </>)}
              {" › "}<span style={{ color: "#1a1816", fontWeight: 500 }}>{currentVendor ? currentVendor.name : ""}</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1.25rem" }}>
              {[
                { label: "Ordered (retail)", value: fmt(currentVendor ? currentVendor.ordered      : 0) },
                { label: "Ordered (cost)",   value: fmt(currentVendor ? currentVendor.orderedCost : 0) },
                { label: "Received (retail)",value: fmt(currentVendor ? currentVendor.received    : 0) },
                { label: "Received (cost)",  value: fmt(currentVendor ? currentVendor.cost        : 0) },
                { label: "Sold (retail)",    value: fmt(currentVendor ? currentVendor.sold        : 0) },
                { label: "SKUs",             value: productRows.length },
              ].map(function(kv) {
                return (
                  <div key={kv.label} style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 6, padding: "7px 13px" }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9e9892", marginBottom: 2 }}>{kv.label}</div>
                    <div style={{ fontWeight: 600, color: "#1a1816" }}>{kv.value}</div>
                  </div>
                );
              })}
            </div>
            {productLoading && <Spinner label="Loading products…" />}
            {productError && <ErrBox msg={productError} />}
            {!productLoading && (
              <TableWrap title={(currentDept ? currentDept.name : "") + " — " + (currentVendor ? currentVendor.name : "")} right={
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                  {["ordered","stock","sold","sale","returned"].map(function(st) {
                    const b = productBuckets[st];
                    return (
                      <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, color: "#6b6560" }}>
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: BUCKET_COLORS[st], display: "inline-block", flexShrink: 0 }} />
                        {BUCKET_LABELS[st]}
                        {b.n > 0 && <span style={{ fontWeight: 600 }}>&nbsp;{b.n} — {fmt(b.v)}</span>}
                      </span>
                    );
                  })}
                </div>
              }>
                {(function() {
                  const handleSort = function(col) {
                    setProductSort(function(prev) {
                      return prev.col === col ? { col, dir: prev.dir * -1 } : { col, dir: -1 };
                    });
                  };
                  const sortVal = function(p, col) {
                    if (col === "name")       return (p.name || "").toLowerCase();
                    if (col === "sku")        return (p.sku  || "").toLowerCase();
                    if (col === "variant")    return (p.variant || "").toLowerCase();
                    if (col === "cost")       return p.cost       || 0;
                    if (col === "price")      return p.price      || 0;
                    if (col === "qtyOrdered") return p.qtyOrdered || 0;
                    if (col === "onHand")     return p.onHand     || 0;
                    if (col === "sold")       return p.sold       || 0;
                    if (col === "onSale")     return p.onSale     || 0;
                    if (col === "returned")   return p.returned   || 0;
                    return 0;
                  };
                  const sorted = productSort.col
                    ? productRows.slice().sort(function(a, b) {
                        const av = sortVal(a, productSort.col), bv = sortVal(b, productSort.col);
                        return av < bv ? -productSort.dir : av > bv ? productSort.dir : 0;
                      })
                    : productRows;
                  const sh = { col: productSort.col, dir: productSort.dir };
                  return (
                    <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "65vh" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            <TH>Status</TH>
                            <SortTH col="name"       sort={sh} onSort={handleSort}>Description</SortTH>
                            <SortTH col="sku"        sort={sh} onSort={handleSort}>SKU</SortTH>
                            <SortTH col="variant"    sort={sh} onSort={handleSort}>Variant</SortTH>
                            <SortTH col="cost"       sort={sh} onSort={handleSort} right>Cost</SortTH>
                            <SortTH col="price"      sort={sh} onSort={handleSort} right>Price</SortTH>
                            <SortTH col="qtyOrdered" sort={sh} onSort={handleSort} right>Ordered</SortTH>
                            <SortTH col="onHand"     sort={sh} onSort={handleSort} right>On Hand</SortTH>
                            <SortTH col="sold"       sort={sh} onSort={handleSort} right>Sold</SortTH>
                            <SortTH col="onSale"     sort={sh} onSort={handleSort} right>On Sale</SortTH>
                            <SortTH col="returned"   sort={sh} onSort={handleSort} right>Returned</SortTH>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.length === 0 ? (
                            <tr><td colSpan={11} style={{ padding: "2.5rem", textAlign: "center", color: "#9e9892" }}>No products found for this vendor in the selected season.</td></tr>
                          ) : sorted.map(function(p, i) {
                            return (
                              <tr key={i} style={{ borderBottom: "1px solid #e2ddd5" }}>
                                <TD><span style={{ display: "flex", gap: 2, flexWrap: "wrap", maxWidth: 36 }}>{s.statusDots(p).map(function(c, di) { return <span key={di} style={{ width: 6, height: 14, borderRadius: 2, background: c, display: "inline-block", flexShrink: 0 }} />; })}</span></TD>
                                <TD>{p.name}</TD>
                                <TD mono>{p.sku}</TD>
                                <TD><span style={{ color: "#6b6560" }}>{p.variant}</span></TD>
                                <TD right>{p.cost       > 0 ? fmt(p.cost)  : ""}</TD>
                                <TD right>{p.price      > 0 ? fmt(p.price) : ""}</TD>
                                <TD right>{p.qtyOrdered > 0 ? p.qtyOrdered : ""}</TD>
                                <TD right>{p.onHand     > 0 ? p.onHand     : ""}</TD>
                                <TD right>{p.sold       > 0 ? p.sold       : ""}</TD>
                                <TD right style={{ color: "#6c3483" }}>{p.onSale    > 0 ? p.onSale    : ""}</TD>
                                <TD right style={{ color: "#000000" }}>{p.returned  > 0 ? p.returned  : ""}</TD>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </TableWrap>
            )}
          </>
        )}

        {/* ── DETAIL placeholder ── */}
        {screen === "detail" && (
          <div style={{ color: "#6b6560", marginTop: "1rem" }}>
            Select a department from the <strong>flow summary</strong> tab to drill into vendor and product detail.
          </div>
        )}

      </div>
    </div>
  );
}
