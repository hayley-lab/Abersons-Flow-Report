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

const SEASONS = [
  { id: "prespring27", name: "Pre-Spring 2027" },
  { id: "fall26",      name: "Fall 2026" },
  { id: "prefall26",   name: "Pre-Fall 2026" },
  { id: "spring26",    name: "Spring 2026" },
  { id: "prespring26", name: "Pre-Spring 2026" },
  { id: "fall25",      name: "Fall 2025" },
  { id: "prefall25",   name: "Pre-Fall 2025" },
  { id: "spring25",    name: "Spring 2025" },
  { id: "prespring25", name: "Pre-Spring 2025" },
  { id: "fall24",      name: "Fall 2024" },
  { id: "prefall24",   name: "Pre-Fall 2024" },
  { id: "spring24",    name: "Spring 2024" },
  { id: "prespring24", name: "Pre-Spring 2024" },
  { id: "fall23",      name: "Fall 2023" },
  { id: "spring23",    name: "Spring 2023" },
];

const DEMO_SUMMARY = [
  { id: "acc",   name: "Accessories",       ordered: 101823,  received: 98413,  sold: 55410  },
  { id: "alley", name: "Alley",             ordered: 922276,  received: 904549, sold: 604999 },
  { id: "alt",   name: "Alterations",       ordered: 0,       received: 0,      sold: 0      },
  { id: "denim", name: "Denim",             ordered: 69531,   received: 68231,  sold: 45600  },
  { id: "des",   name: "Designer",          ordered: 306105,  received: 282960, sold: 149860 },
  { id: "gc",    name: "Gift Certificates", ordered: 0,       received: 0,      sold: 0      },
  { id: "hg",    name: "Home Gifts",        ordered: 0,       received: 0,      sold: 0      },
  { id: "mens",  name: "Mens",              ordered: 472591,  received: 428733, sold: 240091 },
  { id: "next",  name: "Next",              ordered: 617680,  received: 588475, sold: 452816 },
  { id: "shoes", name: "Shoes",             ordered: 329474,  received: 293793, sold: 164143 },
];

const DEMO_VENDORS = {
  acc: [
    { id: "dk",   name: "Dana Kellin",  ordered: 31048, received: 31048, sold: 17854, cost: 12419 },
    { id: "jp",   name: "Judi Powers",  ordered: 30280, received: 30280, sold: 15100, cost: 12112 },
    { id: "re",   name: "Rene Escobar", ordered: 40305, received: 36895, sold: 19866, cost: 14758 },
    { id: "vale", name: "Vale",         ordered: 1830,  received: 1830,  sold: 1830,  cost: 732   },
  ],
  alley: [
    { id: "rag",   name: "Rag & Bone",    ordered: 210500, received: 207800, sold: 145000, cost: 83200  },
    { id: "vince", name: "Vince",         ordered: 189600, received: 185000, sold: 122300, cost: 74000  },
    { id: "tb",    name: "Theory",        ordered: 145000, received: 142000, sold: 99800,  cost: 56800  },
    { id: "eis",   name: "Eileen Fisher", ordered: 377176, received: 369749, sold: 237899, cost: 147900 },
  ],
  denim: [
    { id: "ag",  name: "AG Jeans",  ordered: 35000, received: 34500, sold: 23400, cost: 13800 },
    { id: "dl",  name: "DL1961",    ordered: 20531, received: 20231, sold: 14200, cost: 8090  },
    { id: "mih", name: "MiH Jeans", ordered: 14000, received: 13500, sold: 8000,  cost: 5400  },
  ],
  des: [
    { id: "akris", name: "Akris",      ordered: 89000,  received: 82000,  sold: 41000, cost: 32800 },
    { id: "staud", name: "Staud",      ordered: 72105,  received: 67960,  sold: 38860, cost: 27184 },
    { id: "nili",  name: "Nili Lotan", ordered: 145000, received: 133000, sold: 70000, cost: 53200 },
  ],
  mens: [
    { id: "polo", name: "Ralph Lauren",  ordered: 155000, received: 140000, sold: 78000, cost: 56000 },
    { id: "boss", name: "Hugo Boss",     ordered: 120000, received: 110000, sold: 62000, cost: 44000 },
    { id: "pt01", name: "PT01 Trousers", ordered: 95000,  received: 86000,  sold: 48000, cost: 34400 },
    { id: "sco",  name: "Scott Barber",  ordered: 102591, received: 92733,  sold: 52091, cost: 37093 },
  ],
  next: [
    { id: "vero", name: "Veronica Beard", ordered: 198000, received: 189000, sold: 152000, cost: 75600 },
    { id: "mm",   name: "M.M. LaFleur",   ordered: 165000, received: 159000, sold: 124000, cost: 63600 },
    { id: "wit",  name: "Witchery",       ordered: 254680, received: 240475, sold: 176816, cost: 96190 },
  ],
  shoes: [
    { id: "cl",  name: "Christian Louboutin",   ordered: 98000, received: 87000, sold: 48000, cost: 34800 },
    { id: "hw",  name: "Hogl",                  ordered: 82000, received: 73000, sold: 42000, cost: 29200 },
    { id: "laz", name: "Lavorazione Artigiana", ordered: 72000, received: 65000, sold: 37000, cost: 26000 },
    { id: "sas", name: "SAS Shoes",             ordered: 77474, received: 68793, sold: 37143, cost: 27517 },
  ],
};

const DEMO_PRODUCTS = {
  dk: [
    { name: "dia 14k dia/14k",        sku: "adc2726/pf2501",  variant: "dia/14k",      cost: 825,  price: 2063, onHand: 0, sold: 1, onSale: 0, returned: 0 },
    { name: "dia sil 14k",            sku: "adc2806s/pf2501", variant: "dia/sil/14k",  cost: 350,  price: 875,  onHand: 1, sold: 0, onSale: 0, returned: 0 },
    { name: "ear kyanite 14k",        sku: "ade2939/f2501",   variant: "14k/kyanite",  cost: 1075, price: 2688, onHand: 1, sold: 0, onSale: 0, returned: 0 },
    { name: "ear tahitian pearl 14k", sku: "ade2058/f2501",   variant: "14k",          cost: 526,  price: 1315, onHand: 1, sold: 0, onSale: 0, returned: 0 },
    { name: "neck 14k",               sku: "adc266/f2501",    variant: "14k",          cost: 476,  price: 1190, onHand: 1, sold: 0, onSale: 0, returned: 0 },
    { name: "neck sunstone 14k",      sku: "adc2953/f2501",   variant: "14k/sunstone", cost: 1475, price: 3688, onHand: 1, sold: 0, onSale: 0, returned: 0 },
  ],
};

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

  const [demo, setDemo]           = useState(false);
  const [screen, setScreen]       = useState("summary");
  const [season, setSeason]       = useState("prefall26");

  const [summaryRows, setSummaryRows]   = useState([]);
  const [scanData, setScanData]         = useState(null);   // full KV data for current season
  const [dataLoading, setDataLoading]   = useState(false);
  const [dataError, setDataError]       = useState(null);
  const [dataTs, setDataTs]             = useState(null);   // timestamp of last successful scan

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
  const [productSort, setProductSort]   = useState({ col: null, dir: 1 });

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
    if (demo) { setSummaryRows(DEMO_SUMMARY); return; }
    setDataLoading(true);
    setDataError(null);
    try {
      const r = await fetch(`/api/scan/data?season=${encodeURIComponent(seasonId)}`);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        if (r.status === 401) { setAuthed(false); return; }
        throw new Error(d.error || "HTTP " + r.status);
      }
      const { data } = await r.json();
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
  }, [demo]);

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

    if (demo) {
      setVendorRows(DEMO_VENDORS[dept.id] || []);
      setVendorLoading(false);
      return;
    }

    try {
      const vendors = (scanData && scanData.deptVendors && scanData.deptVendors[dept.id]) || [];
      setVendorRows(vendors.slice().sort((a, b) => b.ordered - a.ordered));
    } catch (e) {
      setVendorError(e.message);
    }
    setVendorLoading(false);
  }, [demo, scanData]);

  // ── vendor drilldown ───────────────────────────────────────────────────────

  const openVendor = useCallback(async function(vendor) {
    setCurrentVendor(vendor);
    setProductRows([]);
    setProductLoading(true);
    setProductError(null);
    setScreen("products");

    if (demo) {
      setProductRows(DEMO_PRODUCTS[vendor.id] || []);
      setProductLoading(false);
      return;
    }

    try {
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
              var d = await apiFetch("2.0/products/" + id);
              return d.data || d;
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
          onHand:     (p.inventory && p.inventory.count != null) ? p.inventory.count : (p.inventory_count || 0),
          sold:       stats.sold     || 0,
          onSale:     stats.onSale   || 0,
          returned:   stats.returned || 0,
        };
      }));
    } catch (e) {
      setProductError(e.message);
    }
    setProductLoading(false);
  }, [demo, currentDept, scanData]);

  // Re-run openVendor if scanData refreshes while we're already on the products screen
  const prevScanDataRef = useRef(null);
  useEffect(() => {
    if (screen === "products" && currentVendor && scanData && scanData !== prevScanDataRef.current) {
      prevScanDataRef.current = scanData;
      openVendor(currentVendor);
    }
  }, [screen, currentVendor, scanData, openVendor]);

  const totalOrdered   = summaryRows.reduce((a, r) => a + r.ordered,  0);
  const totalReceived  = summaryRows.reduce((a, r) => a + r.received, 0);
  const totalSold      = summaryRows.reduce((a, r) => a + r.sold,     0);
  const totalRecPct    = totalOrdered  > 0 ? (totalReceived / totalOrdered)  * 100 : 0;
  const totalSoldPct   = totalReceived > 0 ? (totalSold     / totalReceived) * 100 : 0;
  const vTotalOrdered  = vendorRows.reduce((a, r) => a + r.ordered,  0);
  const vTotalReceived = vendorRows.reduce((a, r) => a + r.received, 0);
  const vTotalSold     = vendorRows.reduce((a, r) => a + r.sold,     0);
  const vTotalCost     = vendorRows.reduce((a, r) => a + (r.cost || 0), 0);

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
    statusDot:  function(status) {
      var colors = { sold: "#4a7ab5", sale: "#9b59b6", stock: "#e05a36", ordered: "#aaa", returned: "#1a1816" };
      return { width: 10, height: 10, borderRadius: "50%", background: colors[status] || "#aaa", display: "inline-block" };
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
  ) : scanError ? (
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
        <nav style={s.nav}>
          <button style={s.navBtn(screen !== "detail")} onClick={function() { setScreen("summary"); }}>flow summary</button>
          <button style={s.navBtn(screen === "detail")} onClick={function() { setScreen("detail"); }}>flow detail</button>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {demo && <span style={s.demoBadge}>demo mode</span>}
          <div style={s.seasonPill}>
            <span style={{ color: "#9e9892", fontSize: 12 }}>▸</span>
            <select value={season} onChange={function(e) { setSeason(e.target.value); setScreen("summary"); }}
              style={{ background: "none", border: "none", fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, color: "#1a1816", cursor: "pointer", outline: "none" }}>
              {SEASONS.map(function(s2) { return <option key={s2.id} value={s2.id}>{s2.name}</option>; })}
            </select>
            <span style={{ color: "#9e9892", fontSize: 12 }}>◂</span>
          </div>
          <button onClick={function() { setDemo(!demo); setScreen("summary"); }}
            style={{ background: "none", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 11px", fontSize: 12, color: "#6b6560", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            {demo ? "Live data" : "Demo mode"}
          </button>
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
                  { label: "Total Ordered",  value: fmt(totalOrdered) },
                  { label: "Total Received", value: fmt(totalReceived), sub: totalRecPct.toFixed(1) + "% of ordered" },
                  { label: "Total Sold",     value: fmt(totalSold),     sub: totalSoldPct.toFixed(1) + "% of received" },
                  { label: "Departments",    value: summaryRows.filter(r => r.ordered > 0 || r.sold > 0).length },
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
                        {scanning ? "↺ Scanning…" : "↺ Refresh"}
                      </button>
                    </div>
                  }>
                  {summaryRows.length === 0 && !scanning ? (
                    <div style={{ padding: "2.5rem", textAlign: "center", color: "#9e9892", fontSize: 13 }}>
                      No scan data yet for {seasonLabel}. Click <strong>↺ Refresh</strong> to run the first scan.
                    </div>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <TH>Sold %</TH><TH>Department</TH><TH right>Ordered</TH>
                          <TH right>Received</TH><TH right>Sold</TH>
                          <TH right>Received %</TH><TH right>Sold %</TH>
                        </tr>
                      </thead>
                      <tbody>
                        {summaryRows.filter(r => r.ordered > 0 || r.received > 0 || r.sold > 0).map(function(r) {
                          var recPct  = r.ordered  > 0 ? (r.received / r.ordered)  * 100 : 0;
                          var soldPct = r.received > 0 ? (r.sold     / r.received) * 100 : 0;
                          var zero    = r.ordered === 0 && r.sold === 0;
                          return (
                            <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={function() { if (!zero) openDept(r); }}>
                              <TD><Bar pct={soldPct} /></TD>
                              <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                              <TD right>{fmt(r.ordered)}</TD>
                              <TD right>{fmt(r.received)}</TD>
                              <TD right>{fmt(r.sold)}</TD>
                              <TD right><PctBadge pct={recPct}  zero={zero} /></TD>
                              <TD right><PctBadge pct={soldPct} zero={zero} /></TD>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </TableWrap>
              </>
            )}
          </>
        )}

        {/* ── VENDORS ── */}
        {screen === "vendors" && (
          <>
            <button style={s.backBtn} onClick={function() { setScreen("summary"); }}>← Store Summary</button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button onClick={function() { setScreen("summary"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>Store Summary</button>
              {" › "}<span style={{ color: "#1a1816", fontWeight: 500 }}>{currentDept ? currentDept.name : ""}</span>
            </div>
            {vendorLoading && <Spinner label="Loading vendors…" />}
            {vendorError && <ErrBox msg={vendorError} />}
            {!vendorLoading && (
              <>
                <KpiRow items={[
                  { label: "Ordered (retail)", value: fmt(vTotalOrdered) },
                  { label: "Cost (wholesale)", value: fmt(vTotalCost) },
                  { label: "Received", value: fmt(vTotalReceived), sub: vTotalOrdered > 0 ? ((vTotalReceived / vTotalOrdered) * 100).toFixed(1) + "%" : "—" },
                  { label: "Sold",     value: fmt(vTotalSold),     sub: vTotalReceived > 0 ? ((vTotalSold / vTotalReceived) * 100).toFixed(1) + "%" : "—" },
                  { label: "Vendors",  value: vendorRows.filter(r => r.ordered > 0 || r.sold > 0).length },
                ]} />
                <TableWrap title={(currentDept ? currentDept.name : "") + " — by Vendor"}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <TH>Sold %</TH><TH>Vendor</TH><TH right>Ordered</TH><TH right>Cost</TH>
                        <TH right>Received</TH><TH right>Sold</TH>
                        <TH right>Received %</TH><TH right>Sold %</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorRows.map(function(r) {
                        var recPct  = r.ordered  > 0 ? (r.received / r.ordered)  * 100 : 0;
                        var soldPct = r.received > 0 ? (r.sold     / r.received) * 100 : 0;
                        var zero    = r.ordered === 0 && r.sold === 0;
                        return (
                          <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={function() { if (!zero) openVendor(r); }}>
                            <TD><Bar pct={soldPct} /></TD>
                            <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                            <TD right>{fmt(r.ordered)}</TD>
                            <TD right style={{ color: "#6b6560" }}>{r.cost > 0 ? fmt(r.cost) : "—"}</TD>
                            <TD right>{fmt(r.received)}</TD>
                            <TD right>{fmt(r.sold)}</TD>
                            <TD right><PctBadge pct={recPct}  zero={zero} /></TD>
                            <TD right><PctBadge pct={soldPct} zero={zero} /></TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              </>
            )}
          </>
        )}

        {/* ── PRODUCTS ── */}
        {screen === "products" && (
          <>
            <button style={s.backBtn} onClick={function() { setScreen("vendors"); }}>← {currentDept ? currentDept.name : ""}</button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button onClick={function() { setScreen("summary"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>Store Summary</button>
              {" › "}
              <button onClick={function() { setScreen("vendors"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>{currentDept ? currentDept.name : ""}</button>
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
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
                  {[["sold","sold","#4a7ab5"],["sale","on sale","#9b59b6"],["stock","in stock","#e05a36"],["ordered","ordered","#aaa"],["returned","returned","#1a1816"]].map(function(e) {
                    return (
                      <div key={e[0]} style={{ display: "flex", alignItems: "center", gap: 5, color: "#6b6560" }}>
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: e[2], display: "inline-block" }} />
                        {e[1]}
                      </div>
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

                  // Totals by status bucket
                  const buckets = { ordered: {n:0,v:0}, stock: {n:0,v:0}, sold: {n:0,v:0}, sale: {n:0,v:0}, returned: {n:0,v:0} };
                  const totalCost = productRows.reduce((a, p) => a + (p.cost || 0), 0);
                  const totalRetail = productRows.reduce((a, p) => a + (p.price || 0), 0);
                  productRows.forEach(function(p) {
                    var st = p.returned > 0 && p.sold === 0 ? "returned" : p.onSale > 0 && p.onSale === p.sold ? "sale" : p.sold > 0 ? "sold" : p.onHand > 0 ? "stock" : "ordered";
                    buckets[st].n++;
                    buckets[st].v += p.price || 0;
                  });
                  const bucketColors = { sold: "#4a7ab5", sale: "#9b59b6", stock: "#e05a36", ordered: "#aaa", returned: "#1a1816" };
                  const bucketLabels = { ordered: "ordered", stock: "in stock", sold: "sold", sale: "on sale", returned: "returned" };

                  return (
                    <>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #e2ddd5", background: "#fafaf8", fontSize: 12 }}>
                      {["ordered","stock","sold","sale","returned"].map(function(st) {
                        const b = buckets[st];
                        return (
                          <span key={st} style={{ background: bucketColors[st], color: "#fff", borderRadius: 4, padding: "3px 8px", fontWeight: 600, opacity: b.n === 0 ? 0.35 : 1 }}>
                            {b.n} {bucketLabels[st]} — {fmt(b.v)}
                          </span>
                        );
                      })}
                      <span style={{ marginLeft: "auto", color: "#6b6560" }}>
                        cost {fmt(totalCost)} &nbsp;|&nbsp; retail {fmt(totalRetail)}
                      </span>
                    </div>
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
                            var status = p.returned > 0 && p.sold === 0 ? "returned" : p.onSale > 0 && p.onSale === p.sold ? "sale" : p.sold > 0 ? "sold" : p.onHand > 0 ? "stock" : "ordered";
                            return (
                              <tr key={i} style={{ borderBottom: "1px solid #e2ddd5" }}>
                                <TD><span style={s.statusDot(status)} /></TD>
                                <TD>{p.name}</TD>
                                <TD mono>{p.sku}</TD>
                                <TD><span style={{ color: "#6b6560" }}>{p.variant}</span></TD>
                                <TD right>{p.cost       > 0 ? fmt(p.cost)  : "—"}</TD>
                                <TD right>{p.price      > 0 ? fmt(p.price) : "—"}</TD>
                                <TD right>{p.qtyOrdered > 0 ? p.qtyOrdered : "—"}</TD>
                                <TD right>{p.onHand     > 0 ? p.onHand     : "—"}</TD>
                                <TD right>{p.sold       > 0 ? p.sold       : "—"}</TD>
                                <TD right style={{ color: p.onSale   > 0 ? "#9b59b6" : "#9e9892" }}>{p.onSale   || "—"}</TD>
                                <TD right style={{ color: p.returned > 0 ? "#1a1816" : "#9e9892" }}>{p.returned || "—"}</TD>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    </>
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
