// pages/index.js
import { useState, useEffect, useCallback, useRef } from "react";

const fmt = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n || 0);

const pctColor = (pct, zero) => {
  if (zero || pct === 0) return { bg: "#f0ede6", color: "#9e9892" };
  if (pct >= 80) return { bg: "#e8f5ee", color: "#2d6a4f" };
  if (pct >= 50) return { bg: "#fef3e2", color: "#92600a" };
  return { bg: "#fdeaea", color: "#8b2020" };
};

const PctBadge = ({ pct, zero }) => {
  const { bg, color } = pctColor(pct, zero);
  return (
    <span
      style={{
        background: bg,
        color,
        borderRadius: 20,
        padding: "2px 8px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {zero ? "0.0%" : `${pct.toFixed(1)}%`}
    </span>
  );
};

const Bar = ({ pct }) => (
  <div style={{ background: "#f0ede6", borderRadius: 3, height: 8, width: 72, overflow: "hidden" }}>
    <div
      style={{
        width: `${Math.min(pct, 100).toFixed(1)}%`,
        height: "100%",
        background: "#2d6a4f",
        borderRadius: 3,
        transition: "width 0.4s ease",
      }}
    />
  </div>
);

const Spinner = ({ label = "Loading…" }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 14,
      padding: "3rem",
      color: "#9e9892",
    }}
  >
    <div
      style={{
        width: 28,
        height: 28,
        border: "2px solid #e2ddd5",
        borderTopColor: "#3a5a8c",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }}
    />
    <div style={{ fontSize: 14 }}>{label}</div>
  </div>
);

const ErrBox = ({ msg }) => (
  <div
    style={{
      background: "#fdeaea",
      border: "1px solid #f0b8b8",
      borderRadius: 10,
      padding: "1rem 1.25rem",
      color: "#8b2020",
      fontSize: 13,
      lineHeight: 1.6,
      marginBottom: "1rem",
    }}
  >
    <strong>Error: </strong>
    {msg}
  </div>
);

const KpiRow = ({ items }) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
      gap: 12,
      marginBottom: "1.5rem",
    }}
  >
    {items.map(({ label, value, sub }) => (
      <div
        key={label}
        style={{
          background: "#fff",
          border: "1px solid #e2ddd5",
          borderRadius: 10,
          padding: "0.9rem 1.1rem",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            color: "#9e9892",
            marginBottom: 4,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, color: "#1a1816", letterSpacing: -0.5 }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: 12, color: "#6b6560", marginTop: 3 }}>{sub}</div>}
      </div>
    ))}
  </div>
);

const TableWrap = ({ title, right, children }) => (
  <div
    style={{
      background: "#fff",
      border: "1px solid #e2ddd5",
      borderRadius: 10,
      boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      overflow: "hidden",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.9rem 1.1rem 0.7rem",
        borderBottom: "1px solid #e2ddd5",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 17 }}>{title}</div>
      {right}
    </div>
    {children}
  </div>
);

const TH = ({ children, right }) => (
  <th
    style={{
      padding: "8px 12px",
      textAlign: right ? "right" : "left",
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      color: "#6b6560",
      whiteSpace: "nowrap",
      background: "#f0ede6",
      borderBottom: "1px solid #e2ddd5",
      position: "sticky",
      top: 0,
      zIndex: 2,
    }}
  >
    {children}
  </th>
);

const SortTH = ({ children, col, sort, onSort, right }) => {
  const active = sort.col === col;
  const arrow = active ? (sort.dir === 1 ? " ↑" : " ↓") : "";
  return (
    <th
      onClick={() => onSort(col)}
      style={{
        padding: "8px 12px",
        textAlign: right ? "right" : "left",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: active ? "#3a5a8c" : "#6b6560",
        whiteSpace: "nowrap",
        background: "#f0ede6",
        borderBottom: "1px solid #e2ddd5",
        position: "sticky",
        top: 0,
        zIndex: 2,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {children}
      {arrow}
    </th>
  );
};

const TD = ({ children, right, mono, style: extraStyle }) => (
  <td
    style={{
      padding: "9px 12px",
      textAlign: right ? "right" : "left",
      fontVariantNumeric: right ? "tabular-nums" : "normal",
      fontFamily: mono ? "monospace" : "inherit",
      fontSize: mono ? 12 : 13,
      color: mono ? "#6b6560" : "#1a1816",
      verticalAlign: "middle",
      ...extraStyle,
    }}
  >
    {children}
  </td>
);

import { SEASONS } from "../lib/seasons";

// ── main component ────────────────────────────────────────────────────────────

export default function FlowReport() {
  const [mounted, setMounted] = useState(false);
  const [authed, setAuthed] = useState(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const [screen, setScreen] = useState("summary");
  const [season, setSeason] = useState(SEASONS[0].id);

  // Persist season selection to localStorage
  const setSeasonAndSave = useCallback(function (id) {
    setSeason(id);
    try {
      localStorage.setItem("flow_season", id);
    } catch (e) {}
  }, []);

  const [summaryRows, setSummaryRows] = useState([]);
  const [scanData, setScanData] = useState(null); // full KV data for current season
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState(null);
  const [dataTs, setDataTs] = useState(null); // timestamp of last successful scan
  const [hasOverride, setHasOverride] = useState(false); // season uses imported override data

  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState("");
  const [scanError, setScanError] = useState(null);
  const [scanInterrupted, setScanInterrupted] = useState(false);
  const scanAbort = useRef(false);

  const [currentDept, setCurrentDept] = useState(null);
  const [vendorRows, setVendorRows] = useState([]);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorError, setVendorError] = useState(null);

  const [currentVendor, setCurrentVendor] = useState(null);
  const [productRows, setProductRows] = useState([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productError, setProductError] = useState(null);
  const [productSort, setProductSort] = useState({ col: "name", dir: 1 });
  const [vendorSort, setVendorSort] = useState({ col: "name", dir: 1 });
  const [summarySort, setSummarySort] = useState({ col: "name", dir: 1 });

  useEffect(() => {
    setMounted(true);
    try {
      const saved = localStorage.getItem("flow_season");
      if (saved && SEASONS.some((s) => s.id === saved)) setSeason(saved);
    } catch (e) {}
  }, []);

  // ── auth check ─────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((d) => setAuthed(d.authenticated === true))
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
        if (r.status === 401) {
          setAuthed(false);
          return;
        }
        throw new Error(d.error || "HTTP " + r.status);
      }
      const { data, job, hasOverride: ov } = await r.json();
      setHasOverride(!!ov);
      const activePhases = new Set([
        "init",
        "products_seed",
        "products",
        "products_slow",
        "products_slow_done",
        "products_fix",
        "products_variants",
        "consignments",
        "returns",
        "inventory",
        "sales",
        "finalizing",
      ]);
      setScanInterrupted(!!(job && activePhases.has(job.phase)));
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

  // When season data reloads, fall back if the current dept/vendor no longer exists
  useEffect(() => {
    if (screen === "dept" && summaryRows.length > 0 && currentDept) {
      const deptExists = summaryRows.some(
        (r) => r.id === currentDept.id || r.name === currentDept.name
      );
      if (!deptExists) setScreen("summary");
    }
  }, [summaryRows, screen, currentDept]);

  useEffect(() => {
    if (screen === "vendors" && vendorRows.length > 0 && currentVendor) {
      const match = vendorRows.find(
        (r) => r.id === currentVendor.id || r.name === currentVendor.name
      );
      if (!match) setScreen("dept");
    }
  }, [vendorRows, screen, currentVendor]);

  // Reload after a completed scan
  const reloadAfterScan = useCallback(() => loadData(season), [loadData, season]);

  // ── auto-poll: silently refresh data when a newer scan is available ─────────
  useEffect(() => {
    if (!authed) return;
    const POLL_MS = 90_000;
    const id = setInterval(async () => {
      if (scanning) return; // don't poll while user-driven scan is in progress
      try {
        const r = await fetch(`/api/scan/data?season=${encodeURIComponent(season)}`);
        if (!r.ok) return;
        const { data } = await r.json();
        if (data && data.ts && data.ts !== dataTs) {
          setScanData(data);
          setSummaryRows(data.summaryRows || []);
          setDataTs(data.ts);
        }
      } catch (_) {}
    }, POLL_MS);
    return () => clearInterval(id);
  }, [authed, season, scanning, dataTs]);

  // ── server-side refresh scan ───────────────────────────────────────────────

  const runScan = useCallback(async () => {
    setScanError(null);
    setScanning(true);
    setScanInterrupted(false);
    setScanProgress("Starting full sync for all seasons…");
    scanAbort.current = false;

    try {
      // Drive all seasons to completion by looping the cron endpoint (same as
      // the nightly GitHub Actions workflow). Each call advances every active
      // season by one chunk; we keep going until all report done/error.
      let allDone = false;
      let iterations = 0;
      while (!allDone && !scanAbort.current && iterations < 300) {
        // First iteration: restart=1 forces a clean start for all seasons (including
        // any that were left in a partial/expired state from a previous scan).
        // Subsequent iterations just advance without restarting.
        const url =
          iterations === 0 ? "/api/cron/scan?force=1&restart=1" : "/api/cron/scan?force=1";
        const r = await fetch(url, { method: "POST" });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          if (r.status === 401) {
            setAuthed(false);
            break;
          }
          // 500/503 = transient error — wait and retry rather than failing
          if (r.status === 503 || r.status === 500) {
            await new Promise((res) => setTimeout(res, 8000));
            continue;
          }
          throw new Error(d.error || "HTTP " + r.status);
        }
        const { results } = await r.json();
        iterations++;

        // Build a progress summary from all seasons
        const active = (results || []).filter((r) => r.action !== "skipped");
        const done = (results || []).filter((r) => r.phase === "done" || r.action === "skipped");
        const errors = (results || []).filter((r) => r.phase === "error");
        if (errors.length) {
          setScanError(errors.map((e) => `${e.season}: ${e.phase}`).join(", "));
        }
        if (active.length > 0) {
          const progressParts = active.map((r) => `${r.season}: ${r.progress || r.phase || "…"}`);
          setScanProgress(progressParts.join(" · "));
        }
        allDone = active.length === 0 || done.length === results.length;
        if (allDone) {
          await reloadAfterScan();
          break;
        }
        await new Promise((res) => setTimeout(res, 5000)); // 5s between chunks
      }
    } catch (e) {
      setScanError(e.message);
    }
    setScanning(false);
  }, [reloadAfterScan]);

  const runDelta = useCallback(async () => {
    if (scanning) return;
    setScanError(null);
    setScanning(true);
    setScanProgress("Quick refresh — loading recent sales…");
    try {
      const r = await fetch("/api/cron/delta", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      await reloadAfterScan();
    } catch (e) {
      setScanError(e.message);
    }
    setScanning(false);
  }, [scanning, reloadAfterScan]);

  // ── department drilldown ───────────────────────────────────────────────────

  const openDept = useCallback(
    function (dept) {
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
    },
    [scanData]
  );

  // ── vendor drilldown ───────────────────────────────────────────────────────

  // Compute vendor-row-compatible totals from a product rows array so they can
  // be flowed up into vendorRows, which drives the dept-level summary header.
  const flowUpVendorTotals = useCallback(function (vendor, rows) {
    const t = {
      ordered: 0,
      orderedCost: 0,
      received: 0,
      cost: 0,
      returned: 0,
      returnedCost: 0,
      sold: 0,
    };
    rows.forEach(function (p) {
      const price = p.price || 0,
        c = p.cost || 0;
      const ret = p.returned || 0;
      const rawOrdered = p.orderedRaw != null ? p.orderedRaw : p.qtyOrdered || 0;
      const rawReceived =
        p.receivedRaw != null
          ? p.receivedRaw
          : (p.onHand || 0) + (p.sold || 0) + (p.onSale || 0) + ret;
      t.ordered += Math.max(0, rawOrdered - ret) * price;
      t.orderedCost += Math.max(0, rawOrdered - ret) * c;
      t.received += Math.max(0, rawReceived - ret) * price;
      t.cost += Math.max(0, rawReceived - ret) * c;
      t.returned += ret * price;
      t.returnedCost += ret * c;
      t.sold += (p.sold || 0) * price;
    });
    setVendorRows(function (prev) {
      return prev.map(function (r) {
        return r.id === vendor.id || r.name === vendor.name ? Object.assign({}, r, t) : r;
      });
    });
  }, []);

  const productRowFromPid = useCallback(
    function (pid, fallback) {
      fallback = fallback || {};
      const productStats = (scanData && scanData.productStats) || {};
      const stats = productStats[pid] || {};
      const pidToQtyOrdered = (scanData && scanData.pidToQtyOrdered) || {};
      const pidToQtyReceived = (scanData && scanData.pidToQtyReceived) || {};
      const pidToQtyReturned = (scanData && scanData.pidToQtyReturned) || {};
      const pidToPrice = (scanData && scanData.pidToPrice) || {};
      const pidToCost = (scanData && scanData.pidToCost) || {};
      const pidToName = (scanData && scanData.pidToName) || {};
      const pidToSku = (scanData && scanData.pidToSku) || {};
      const pidToVariant = (scanData && scanData.pidToVariant) || {};
      const orderedRaw =
        stats.qtyOrdered != null
          ? stats.qtyOrdered
          : pid && pidToQtyOrdered[pid] != null
            ? pidToQtyOrdered[pid]
            : fallback.qtyOrdered || 0;
      const receivedRaw =
        stats.qtyReceived != null
          ? stats.qtyReceived
          : pid && pidToQtyReceived[pid] != null
            ? pidToQtyReceived[pid]
            : fallback.qtyReceived || fallback.qtyStock || 0;
      const returned =
        stats.retQty != null
          ? stats.retQty
          : pid && pidToQtyReturned[pid] != null
            ? pidToQtyReturned[pid]
            : fallback.qtyReturned || 0;
      const sold = stats.sold != null ? stats.sold : fallback.qtySold || 0;
      const onSale = stats.onSale != null ? stats.onSale : fallback.qtySale || 0;
      const onHand = Math.max(0, receivedRaw - sold - onSale - returned);
      const onOrder = Math.max(0, orderedRaw - receivedRaw);
      return {
        name: pidToName[pid] || fallback.description || "",
        sku: pidToSku[pid] || fallback.style || "",
        variant:
          pidToVariant[pid] ||
          [fallback.color, fallback.fabric, fallback.size].filter(Boolean).join(" / "),
        cost: pidToCost[pid] != null ? pidToCost[pid] : fallback.cost || 0,
        price: pidToPrice[pid] != null ? pidToPrice[pid] : fallback.price || 0,
        qtyOrdered: onOrder,
        orderedRaw,
        receivedRaw,
        onHand,
        sold,
        onSale,
        returned,
        saleAmt: stats.saleAmt || 0,
        inventoryMismatch: stats.inventoryMismatch || false,
        liveOnHand: stats.liveOnHand,
      };
    },
    [scanData]
  );

  const openVendor = useCallback(
    async function (vendor) {
      setCurrentVendor(vendor);
      setProductRows([]);
      setProductLoading(true);
      setProductError(null);
      setScreen("products");

      try {
        // Find this vendor's product IDs in this dept from the pre-scanned data
        const seasonPids = (scanData && scanData.seasonPids) || [];
        const pidToType = (scanData && scanData.pidToType) || {};
        const pidToSupplier = (scanData && scanData.pidToSupplier) || {};

        const targetIds = seasonPids.filter(function (id) {
          const sup = pidToSupplier[id];
          const typ = pidToType[id];
          return (
            sup && (sup.i || sup.id) === vendor.id && (typ === currentDept.id || typ === "__none__")
          );
        });

        // For historical import seasons, products are stored in the vendor object directly.
        // Only use override products when the LS scan has no products for this vendor+dept.
        if (vendor.overrideProducts && targetIds.length === 0) {
          const skuToPid = (scanData && scanData.skuToPid) || {};

          const overrideRows = vendor.overrideProducts.map(function (p) {
            const pid = skuToPid[(p.style || "").toLowerCase().trim()];
            return productRowFromPid(pid, p);
          });
          setProductRows(overrideRows);
          flowUpVendorTotals(vendor, overrideRows);
          setProductLoading(false);
          return;
        }

        const lsRows = targetIds.map(function (pid) {
          return productRowFromPid(pid);
        });
        setProductRows(lsRows);
        flowUpVendorTotals(vendor, lsRows);
      } catch (e) {
        setProductError(e.message);
      }
      setProductLoading(false);
    },
    [currentDept, flowUpVendorTotals, productRowFromPid, scanData]
  );

  // ── vendor all-departments drilldown (from summary vendor list) ──────────────

  const openVendorProducts = useCallback(
    async function (vendorInfo) {
      setCurrentVendor({ ...vendorInfo, allDepts: true });
      setCurrentDept(null);
      setProductRows([]);
      setProductLoading(true);
      setProductError(null);
      setScreen("products");

      try {
        const skuToPid = (scanData && scanData.skuToPid) || {};
        const deptVendors = (scanData && scanData.deptVendors) || {};

        // Collect all vendor entries across departments matching this vendor
        const normVendorName = (vendorInfo.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const allEntries = [];
        Object.values(deptVendors).forEach(function (vendors) {
          vendors.forEach(function (v) {
            const vNorm = (v.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            if (String(v.id) === String(vendorInfo.id) || vNorm === normVendorName) {
              allEntries.push(v);
            }
          });
        });

        // LS scan path — filter seasonPids by vendor only (no dept filter)
        const seasonPids = (scanData && scanData.seasonPids) || [];
        const pidToSupplier = (scanData && scanData.pidToSupplier) || {};

        const targetIds = seasonPids.filter(function (id) {
          const sup = pidToSupplier[id];
          return sup && (sup.i || sup.id) === vendorInfo.id;
        });

        // Override products path — only use when LS scan has no products for this vendor
        // (historical seasons where products aren't in LS scan results)
        const overrideProducts = allEntries.flatMap(function (v) {
          return v.overrideProducts || [];
        });
        if (overrideProducts.length > 0 && targetIds.length === 0) {
          setProductRows(
            overrideProducts.map(function (p) {
              const pid = skuToPid[(p.style || "").toLowerCase().trim()];
              return productRowFromPid(pid, p);
            })
          );
          setProductLoading(false);
          return;
        }

        setProductRows(
          targetIds.map(function (pid) {
            return productRowFromPid(pid);
          })
        );
      } catch (e) {
        setProductError(e.message);
      }
      setProductLoading(false);
    },
    [productRowFromPid, scanData]
  );

  // Re-run openVendor if scanData refreshes while we're already on the products screen
  const prevScanDataRef = useRef(null);
  useEffect(() => {
    if (
      screen === "products" &&
      currentVendor &&
      scanData &&
      scanData !== prevScanDataRef.current
    ) {
      prevScanDataRef.current = scanData;
      // Use fresh vendor data from new season so header stats update on season change
      const freshVendor =
        vendorRows.find((r) => r.id === currentVendor.id || r.name === currentVendor.name) ||
        currentVendor;
      openVendor(freshVendor);
    }
  }, [screen, currentVendor, scanData, openVendor, vendorRows]);

  const totalOrdered = summaryRows.reduce((a, r) => a + (r.ordered || 0), 0);
  const totalOrderedCost = summaryRows.reduce((a, r) => a + (r.orderedCost || 0), 0);
  const totalReceived = summaryRows.reduce((a, r) => a + (r.received || 0), 0);
  const totalReceivedCost = summaryRows.reduce((a, r) => a + (r.cost || 0), 0);
  const totalSold = summaryRows.reduce((a, r) => a + (r.sold || 0), 0);
  const totalNetReceived = totalReceived;
  const totalNetReceivedCost = totalReceivedCost;
  const totalRecPct = totalOrdered > 0 ? (totalReceived / totalOrdered) * 100 : 0;
  const totalSoldPct = totalReceived > 0 ? (totalSold / totalReceived) * 100 : 0;
  const vTotalOrdered = vendorRows.reduce((a, r) => a + (r.ordered || 0), 0);
  const vTotalOrderedCost = vendorRows.reduce((a, r) => a + (r.orderedCost || 0), 0);
  const vTotalReceived = vendorRows.reduce((a, r) => a + (r.received || 0), 0);
  const vTotalReceivedCost = vendorRows.reduce((a, r) => a + (r.cost || 0), 0);
  const vTotalSold = vendorRows.reduce((a, r) => a + (r.sold || 0), 0);

  const BUCKET_COLORS = {
    sold: "#4a7ab5",
    sale: "#6c3483",
    stock: "#c0392b",
    ordered: "#aaa",
    returned: "#000000",
  };
  const BUCKET_LABELS = {
    ordered: "on order",
    stock: "in stock",
    sold: "sold",
    sale: "on sale",
    returned: "returned",
  };
  const productBuckets = (function () {
    const b = {
      ordered: { n: 0, v: 0 },
      stock: { n: 0, v: 0 },
      sold: { n: 0, v: 0 },
      sale: { n: 0, v: 0 },
      returned: { n: 0, v: 0 },
    };
    productRows.forEach(function (p) {
      const price = p.price || 0;
      // sold and onSale are now mutually exclusive buckets (onSale items not in sold)
      const notReceived = p.qtyOrdered || 0;
      if (p.sold > 0) {
        b.sold.n++;
        b.sold.v += price * p.sold;
      }
      if (p.onSale > 0) {
        b.sale.n++;
        b.sale.v += p.saleAmt || price * p.onSale;
      }
      if (p.onHand > 0) {
        b.stock.n++;
        b.stock.v += price * p.onHand;
      }
      if (p.returned > 0) {
        b.returned.n++;
        b.returned.v += price * p.returned;
      }
      if (notReceived > 0) {
        b.ordered.n++;
        b.ordered.v += price * notReceived;
      }
    });
    return b;
  })();

  // Product-level totals for vendor header — computed from live prices so they
  // always match the product list and color key regardless of scan-time price accuracy.
  const productTotals = (function () {
    const t = {
      orderedRetail: 0,
      orderedCost: 0,
      receivedRetail: 0,
      receivedCost: 0,
      returnedRetail: 0,
      returnedCost: 0,
      soldRetail: 0,
    };
    productRows.forEach(function (p) {
      const price = p.price || 0;
      const cost = p.cost || 0;
      const rawOrdered = p.orderedRaw != null ? p.orderedRaw : p.qtyOrdered || 0;
      const rawReceived =
        p.receivedRaw != null
          ? p.receivedRaw
          : (p.onHand || 0) + (p.sold || 0) + (p.onSale || 0) + (p.returned || 0);
      t.orderedRetail += Math.max(0, rawOrdered - (p.returned || 0)) * price;
      t.orderedCost += Math.max(0, rawOrdered - (p.returned || 0)) * cost;
      t.receivedRetail += Math.max(0, rawReceived - (p.returned || 0)) * price;
      t.receivedCost += Math.max(0, rawReceived - (p.returned || 0)) * cost;
      t.returnedRetail += (p.returned || 0) * price;
      t.returnedCost += (p.returned || 0) * cost;
      t.soldRetail += (p.sold || 0) * price;
    });
    return t;
  })();

  let seasonLabel = "";
  for (let sIdx = 0; sIdx < SEASONS.length; sIdx++) {
    if (SEASONS[sIdx].id === season) {
      seasonLabel = SEASONS[sIdx].name;
      break;
    }
  }
  if (!seasonLabel) seasonLabel = season;

  // ── styles ─────────────────────────────────────────────────────────────────

  const s = {
    app: {
      fontFamily: "'DM Sans',sans-serif",
      background: "#f7f5f0",
      minHeight: "100vh",
      fontSize: 14,
    },
    header: {
      background: "#fff",
      borderBottom: "1px solid #e2ddd5",
      padding: "0 1.5rem",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      height: 56,
      position: "sticky",
      top: 0,
      zIndex: 100,
    },
    logo: {
      fontFamily: "'DM Serif Display',serif",
      fontSize: 22,
      color: "#1a1816",
      letterSpacing: -0.5,
    },
    nav: { display: "flex", gap: 4 },
    navBtn: function (active) {
      return {
        background: active ? "#e8eef7" : "none",
        border: "none",
        padding: "6px 13px",
        borderRadius: 6,
        fontSize: 13,
        color: active ? "#3a5a8c" : "#6b6560",
        cursor: "pointer",
        fontFamily: "'DM Sans',sans-serif",
        fontWeight: 500,
      };
    },
    main: { padding: "1.75rem 1.5rem", maxWidth: 1200, margin: "0 auto" },
    seasonPill: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      background: "#f0ede6",
      border: "1px solid #e2ddd5",
      borderRadius: 6,
      padding: "5px 10px",
      fontSize: 13,
      fontWeight: 500,
    },
    tableRow: function (clickable, zero) {
      return {
        borderBottom: "1px solid #e2ddd5",
        cursor: clickable && !zero ? "pointer" : "default",
        opacity: zero ? 0.45 : 1,
        transition: "background 0.1s",
      };
    },
    backBtn: {
      background: "none",
      border: "none",
      color: "#3a5a8c",
      cursor: "pointer",
      fontFamily: "'DM Sans',sans-serif",
      fontSize: 13,
      fontWeight: 500,
      textDecoration: "underline",
      textUnderlineOffset: 2,
      padding: 0,
      marginBottom: "0.9rem",
    },
    demoBadge: {
      background: "#fef3e2",
      color: "#92600a",
      border: "1px solid #f5d9a0",
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 600,
      padding: "3px 10px",
      letterSpacing: "0.04em",
    },
    statusDots: function (p) {
      const C = {
        sold: "#4a7ab5",
        sale: "#6c3483",
        stock: "#c0392b",
        ordered: "#aaa",
        returned: "#000000",
      };
      const notReceived = p.qtyOrdered || 0;
      const marks = [
        { color: C.sold, n: p.sold || 0 },
        { color: C.sale, n: p.onSale || 0 },
        { color: C.stock, n: p.onHand || 0 },
        { color: C.returned, n: p.returned || 0 },
        { color: C.ordered, n: notReceived },
      ];
      const dots = [];
      marks.forEach(function (m) {
        for (let i = 0; i < m.n; i++) {
          dots.push(m.color);
        }
      });
      return dots;
    },
  };

  const fontLink =
    "@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500;600&display=swap'); @keyframes spin{to{transform:rotate(360deg)}} tbody tr:hover{background:#f0f5fb!important}";

  // ── login screen ────────────────────────────────────────────────────────────

  if (authed === null)
    return (
      <div style={s.app}>
        <style>{fontLink}</style>
        <header style={s.header}>
          <div style={s.logo}>abersons</div>
        </header>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "calc(100vh - 56px)",
          }}
        >
          <Spinner label="Checking login…" />
        </div>
      </div>
    );

  if (authed === false)
    return (
      <div style={s.app}>
        <style>{fontLink}</style>
        <header style={s.header}>
          <div style={s.logo}>abersons</div>
        </header>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "calc(100vh - 56px)",
            gap: 16,
          }}
        >
          <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 26, color: "#1a1816" }}>
            Flow Report
          </div>
          <form
            onSubmit={handleLogin}
            style={{ display: "flex", flexDirection: "column", gap: 10, width: 280 }}
          >
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: "1px solid #e2ddd5",
                fontSize: 14,
                fontFamily: "'DM Sans',sans-serif",
                outline: "none",
              }}
            />
            {loginError && <div style={{ color: "#8b2020", fontSize: 13 }}>{loginError}</div>}
            <button
              type="submit"
              disabled={loginLoading}
              style={{
                background: "#3a5a8c",
                color: "#fff",
                padding: "10px 0",
                borderRadius: 8,
                border: "none",
                fontSize: 14,
                fontWeight: 500,
                cursor: loginLoading ? "default" : "pointer",
                opacity: loginLoading ? 0.7 : 1,
                fontFamily: "'DM Sans',sans-serif",
              }}
            >
              {loginLoading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );

  // ── scan-in-progress banner ────────────────────────────────────────────────

  const ScanBanner = scanning ? (
    <div
      style={{
        background: "#e8eef7",
        border: "1px solid #b8cce4",
        borderRadius: 8,
        padding: "10px 16px",
        marginBottom: "1rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 16,
            height: 16,
            border: "2px solid #b8cce4",
            borderTopColor: "#3a5a8c",
            borderRadius: "50%",
            animation: "spin 0.7s linear infinite",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, color: "#3a5a8c" }}>{scanProgress}</span>
      </div>
      <button
        onClick={() => {
          scanAbort.current = true;
          setScanning(false);
        }}
        style={{
          background: "none",
          border: "none",
          fontSize: 12,
          color: "#6b6560",
          cursor: "pointer",
          fontFamily: "'DM Sans',sans-serif",
        }}
      >
        cancel
      </button>
    </div>
  ) : scanError ? (
    <div
      style={{
        background: "#fdeaea",
        border: "1px solid #f0b8b8",
        borderRadius: 8,
        padding: "10px 16px",
        marginBottom: "1rem",
        fontSize: 13,
        color: "#8b2020",
      }}
    >
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
            {(function () {
              const idx = SEASONS.findIndex(function (s2) {
                return s2.id === season;
              });
              const prev = SEASONS[idx - 1];
              const next = SEASONS[idx + 1];
              const btnStyle = function (enabled) {
                return {
                  background: "none",
                  border: "none",
                  padding: "0 3px",
                  fontSize: 20,
                  lineHeight: 1,
                  color: enabled ? "#3a5a8c" : "#ccc",
                  cursor: enabled ? "pointer" : "default",
                  fontFamily: "'DM Sans',sans-serif",
                };
              };
              return (
                <>
                  <button
                    style={btnStyle(!!next)}
                    disabled={!next}
                    onClick={function () {
                      if (next) setSeasonAndSave(next.id);
                    }}
                  >
                    ‹
                  </button>
                  <select
                    value={season}
                    onChange={function (e) {
                      setSeasonAndSave(e.target.value);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      fontFamily: "'DM Sans',sans-serif",
                      fontSize: 12,
                      fontWeight: 500,
                      color: "#1a1816",
                      cursor: "pointer",
                      outline: "none",
                    }}
                  >
                    {SEASONS.map(function (s2) {
                      return (
                        <option key={s2.id} value={s2.id}>
                          {s2.name}
                        </option>
                      );
                    })}
                  </select>
                  <button
                    style={btnStyle(!!prev)}
                    disabled={!prev}
                    onClick={function () {
                      if (prev) setSeasonAndSave(prev.id);
                    }}
                  >
                    ›
                  </button>
                </>
              );
            })()}
          </div>
          <button
            onClick={function () {
              fetch("/api/auth/logout").then(function () {
                setAuthed(false);
              });
            }}
            style={{
              background: "none",
              border: "none",
              padding: "5px 8px",
              fontSize: 12,
              color: "#9e9892",
              cursor: "pointer",
              fontFamily: "'DM Sans',sans-serif",
            }}
          >
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
                <KpiRow
                  items={[
                    { label: "Ordered (retail)", value: fmt(totalOrdered) },
                    { label: "Ordered (cost)", value: fmt(totalOrderedCost) },
                    {
                      label: "Received (retail)",
                      value: fmt(totalNetReceived),
                      sub: totalRecPct.toFixed(1) + "% of ordered",
                    },
                    { label: "Received (cost)", value: fmt(totalNetReceivedCost) },
                    {
                      label: "Sold (retail)",
                      value: fmt(totalSold),
                      sub: totalSoldPct.toFixed(1) + "% of received",
                    },
                    {
                      label: "Departments",
                      value: summaryRows.filter((r) => r.ordered > 0 || r.sold > 0).length,
                    },
                  ]}
                />
                <TableWrap
                  title={"Store Summary — " + seasonLabel}
                  right={
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {dataTs && !scanning && mounted && (
                        <span style={{ fontSize: 11, color: "#9e9892" }}>
                          updated{" "}
                          {new Date(dataTs).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                      {scanInterrupted && !scanning && (
                        <button
                          onClick={() => runScan()}
                          style={{
                            background: "none",
                            border: "1px solid #f5c842",
                            borderRadius: 6,
                            padding: "5px 11px",
                            fontSize: 12,
                            fontWeight: 500,
                            color: "#9a7d0a",
                            cursor: "pointer",
                          }}
                        >
                          ↺ Resume interrupted scan
                        </button>
                      )}
                      {dataTs && !scanning && (
                        <button
                          onClick={runDelta}
                          style={{
                            background: "none",
                            border: "1px solid #b8d4b8",
                            borderRadius: 6,
                            padding: "5px 11px",
                            fontSize: 12,
                            fontWeight: 500,
                            color: "#3a7a3a",
                            cursor: "pointer",
                          }}
                        >
                          ⚡ Quick Refresh
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (!scanning) runScan();
                        }}
                        disabled={scanning}
                        style={{
                          background: "none",
                          border: "1px solid #e2ddd5",
                          borderRadius: 6,
                          padding: "5px 11px",
                          fontSize: 12,
                          fontWeight: 500,
                          color: scanning ? "#b0aba5" : "#6b6560",
                          cursor: scanning ? "default" : "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                        }}
                      >
                        {scanning ? "↺ Scanning…" : hasOverride ? "↺ Sync from LS" : "↺ Refresh"}
                      </button>
                    </div>
                  }
                >
                  {summaryRows.length === 0 && !scanning ? (
                    <div
                      style={{
                        padding: "2.5rem",
                        textAlign: "center",
                        color: "#9e9892",
                        fontSize: 13,
                      }}
                    >
                      {hasOverride ? (
                        <>
                          Historical data imported. Click <strong>↺ Sync from LS</strong> to pull
                          live sales &amp; stock.
                        </>
                      ) : (
                        <>
                          No scan data yet for {seasonLabel}. Click <strong>↺ Refresh</strong> to
                          run the first scan.
                        </>
                      )}
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>
                            <TH>Sold %</TH>
                            <SortTH
                              col="name"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                            >
                              Department
                            </SortTH>
                            <SortTH
                              col="ordered"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                              right
                            >
                              Ordered (retail)
                            </SortTH>
                            <SortTH
                              col="orderedCost"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                              right
                            >
                              Ordered (cost)
                            </SortTH>
                            <SortTH
                              col="received"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                              right
                            >
                              Received (retail)
                            </SortTH>
                            <SortTH
                              col="cost"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                              right
                            >
                              Received (cost)
                            </SortTH>
                            <SortTH
                              col="sold"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                              right
                            >
                              Sold (retail)
                            </SortTH>
                            <SortTH
                              col="recPct"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                              right
                            >
                              Received %
                            </SortTH>
                            <SortTH
                              col="soldPct"
                              sort={summarySort}
                              onSort={function (c) {
                                setSummarySort(function (p) {
                                  return p.col === c
                                    ? { col: c, dir: p.dir * -1 }
                                    : { col: c, dir: -1 };
                                });
                              }}
                              right
                            >
                              Sold %
                            </SortTH>
                          </tr>
                        </thead>
                        <tbody>
                          {summaryRows
                            .filter((r) => r.ordered > 0 || r.received > 0 || r.sold > 0)
                            .map(function (r) {
                              const netReceived = r.received || 0;
                              const recPct = r.ordered > 0 ? (netReceived / r.ordered) * 100 : 0;
                              const soldPct = netReceived > 0 ? (r.sold / netReceived) * 100 : 0;
                              return { ...r, recPct, soldPct };
                            })
                            .sort(function (a, b) {
                              const col = summarySort.col;
                              const av =
                                col === "name" ? (a.name || "").toLowerCase() : a[col] || 0;
                              const bv =
                                col === "name" ? (b.name || "").toLowerCase() : b[col] || 0;
                              return av < bv ? -summarySort.dir : av > bv ? summarySort.dir : 0;
                            })
                            .map(function (r) {
                              const zero = r.ordered === 0 && r.sold === 0;
                              return (
                                <tr
                                  key={r.id}
                                  style={s.tableRow(!zero, zero)}
                                  onClick={function () {
                                    if (!zero) openDept(r);
                                  }}
                                >
                                  <TD>
                                    <Bar pct={r.soldPct} />
                                  </TD>
                                  <TD>
                                    <span style={{ fontWeight: 500 }}>{r.name}</span>
                                  </TD>
                                  <TD right>{r.ordered > 0 ? fmt(r.ordered) : ""}</TD>
                                  <TD right>{r.orderedCost > 0 ? fmt(r.orderedCost) : ""}</TD>
                                  <TD right>{r.received > 0 ? fmt(r.received) : ""}</TD>
                                  <TD right>{r.cost > 0 ? fmt(r.cost) : ""}</TD>
                                  <TD right>{r.sold > 0 ? fmt(r.sold) : ""}</TD>
                                  <TD right>
                                    <PctBadge pct={r.recPct} zero={zero} />
                                  </TD>
                                  <TD right>
                                    <PctBadge pct={r.soldPct} zero={zero} />
                                  </TD>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </TableWrap>

                {/* ── Vendor Index ── */}
                {(function () {
                  if (!scanData || !scanData.deptVendors) return null;
                  // Build map: vendorId → {name, bestDept (highest ordered)}
                  const vendorMap = {};
                  const deptVendors = scanData.deptVendors;
                  Object.keys(deptVendors).forEach(function (deptId) {
                    const dept = summaryRows.find(function (r) {
                      return String(r.id) === String(deptId);
                    });
                    deptVendors[deptId].forEach(function (v) {
                      if (!v.name) return;
                      if (!vendorMap[v.id]) {
                        vendorMap[v.id] = {
                          id: v.id,
                          name: v.name,
                          bestDept: dept,
                          bestOrdered: v.ordered || 0,
                        };
                      } else if ((v.ordered || 0) > vendorMap[v.id].bestOrdered) {
                        vendorMap[v.id].bestDept = dept;
                        vendorMap[v.id].bestOrdered = v.ordered || 0;
                      }
                    });
                  });
                  const allVendors = Object.values(vendorMap).sort(function (a, b) {
                    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
                  });
                  if (allVendors.length === 0) return null;
                  // Group by first letter
                  const groups = {};
                  allVendors.forEach(function (v) {
                    let letter = v.name[0].toUpperCase();
                    if (!/[A-Z]/.test(letter)) letter = "#";
                    if (!groups[letter]) groups[letter] = [];
                    groups[letter].push(v);
                  });
                  const letters = Object.keys(groups).sort(function (a, b) {
                    if (a === "#") return -1;
                    if (b === "#") return 1;
                    return a < b ? -1 : 1;
                  });
                  return (
                    <div
                      style={{
                        marginTop: "1.5rem",
                        background: "#fff",
                        border: "1px solid #e2ddd5",
                        borderRadius: 10,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                        padding: "1rem 1.25rem",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'DM Serif Display',serif",
                          fontSize: 17,
                          marginBottom: "1rem",
                        }}
                      >
                        Vendor List
                      </div>
                      {letters.map(function (letter) {
                        return (
                          <div
                            key={letter}
                            style={{
                              marginBottom: "0.75rem",
                              display: "flex",
                              gap: 8,
                              alignItems: "baseline",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#9e9892",
                                width: 18,
                                flexShrink: 0,
                              }}
                            >
                              {letter}
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 0" }}>
                              {groups[letter].map(function (v, i) {
                                return (
                                  <span key={v.id}>
                                    <button
                                      onClick={function () {
                                        openVendorProducts(v);
                                      }}
                                      style={{
                                        background: "none",
                                        border: "none",
                                        padding: "0 4px",
                                        fontFamily: "'DM Sans',sans-serif",
                                        fontSize: 13,
                                        color: v.bestDept ? "#3a5a8c" : "#9e9892",
                                        cursor: v.bestDept ? "pointer" : "default",
                                        textDecoration: v.bestDept ? "underline" : "none",
                                        textUnderlineOffset: 2,
                                      }}
                                    >
                                      {v.name}
                                    </button>
                                    {i < groups[letter].length - 1 && (
                                      <span style={{ color: "#d0ccc5", fontSize: 11 }}>|</span>
                                    )}
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
            <button
              style={s.backBtn}
              onClick={function () {
                setScreen("summary");
              }}
            >
              ← Store Summary
            </button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1rem" }}>
              <button
                onClick={function () {
                  setScreen("summary");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#3a5a8c",
                  cursor: "pointer",
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: 13,
                  textDecoration: "underline",
                  textUnderlineOffset: 2,
                  padding: 0,
                }}
              >
                Store Summary
              </button>
              {" › "}
              <span style={{ color: "#1a1816", fontWeight: 500 }}>
                {currentDept ? currentDept.name : ""}
              </span>
            </div>
            {/* Department jump pills */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: "1.25rem" }}>
              {summaryRows
                .filter(function (r) {
                  return r.ordered > 0 || r.sold > 0;
                })
                .sort(function (a, b) {
                  return (a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1;
                })
                .map(function (r) {
                  const active = currentDept && String(r.id) === String(currentDept.id);
                  return (
                    <button
                      key={r.id}
                      onClick={function () {
                        if (!active) openDept(r);
                      }}
                      style={{
                        background: active ? "#3a5a8c" : "#fff",
                        color: active ? "#fff" : "#3a5a8c",
                        border: "1px solid " + (active ? "#3a5a8c" : "#b8cce4"),
                        borderRadius: 20,
                        padding: "4px 13px",
                        fontSize: 12,
                        fontWeight: active ? 600 : 400,
                        fontFamily: "'DM Sans',sans-serif",
                        cursor: active ? "default" : "pointer",
                      }}
                    >
                      {r.name}
                    </button>
                  );
                })}
            </div>
            {vendorLoading && <Spinner label="Loading vendors…" />}
            {vendorError && <ErrBox msg={vendorError} />}
            {!vendorLoading && (
              <>
                <KpiRow
                  items={[
                    { label: "Ordered (retail)", value: fmt(vTotalOrdered) },
                    { label: "Ordered (cost)", value: fmt(vTotalOrderedCost) },
                    {
                      label: "Received (retail)",
                      value: fmt(vTotalReceived),
                      sub:
                        vTotalOrdered > 0
                          ? ((vTotalReceived / vTotalOrdered) * 100).toFixed(1) + "% of ordered"
                          : "0.0% of ordered",
                    },
                    { label: "Received (cost)", value: fmt(vTotalReceivedCost) },
                    {
                      label: "Sold (retail)",
                      value: fmt(vTotalSold),
                      sub:
                        vTotalReceived > 0
                          ? ((vTotalSold / vTotalReceived) * 100).toFixed(1) + "% of received"
                          : "0.0% of received",
                    },
                    {
                      label: "Vendors",
                      value: vendorRows.filter((r) => r.ordered > 0 || r.sold > 0).length,
                    },
                  ]}
                />
                <TableWrap title={(currentDept ? currentDept.name : "") + " — by Vendor"}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <TH>Sold %</TH>
                          <SortTH
                            col="name"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                          >
                            Vendor
                          </SortTH>
                          <SortTH
                            col="ordered"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                            right
                          >
                            Ordered (retail)
                          </SortTH>
                          <SortTH
                            col="orderedCost"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                            right
                          >
                            Ordered (cost)
                          </SortTH>
                          <SortTH
                            col="received"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                            right
                          >
                            Received (retail)
                          </SortTH>
                          <SortTH
                            col="cost"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                            right
                          >
                            Received (cost)
                          </SortTH>
                          <SortTH
                            col="sold"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                            right
                          >
                            Sold (retail)
                          </SortTH>
                          <SortTH
                            col="recPct"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                            right
                          >
                            Received %
                          </SortTH>
                          <SortTH
                            col="soldPct"
                            sort={vendorSort}
                            onSort={function (c) {
                              setVendorSort(function (p) {
                                return p.col === c
                                  ? { col: c, dir: p.dir * -1 }
                                  : { col: c, dir: -1 };
                              });
                            }}
                            right
                          >
                            Sold %
                          </SortTH>
                        </tr>
                      </thead>
                      <tbody>
                        {vendorRows
                          .map(function (r) {
                            const vNetReceived = r.received || 0;
                            const recPct = r.ordered > 0 ? (vNetReceived / r.ordered) * 100 : 0;
                            const soldPct = vNetReceived > 0 ? (r.sold / vNetReceived) * 100 : 0;
                            return { ...r, recPct, soldPct };
                          })
                          .sort(function (a, b) {
                            const col = vendorSort.col;
                            const av = col === "name" ? (a.name || "").toLowerCase() : a[col] || 0;
                            const bv = col === "name" ? (b.name || "").toLowerCase() : b[col] || 0;
                            return av < bv ? -vendorSort.dir : av > bv ? vendorSort.dir : 0;
                          })
                          .map(function (r) {
                            const zero = r.ordered === 0 && r.sold === 0;
                            return (
                              <tr
                                key={r.id}
                                style={s.tableRow(!zero, zero)}
                                onClick={function () {
                                  if (!zero) openVendor(r);
                                }}
                              >
                                <TD>
                                  <Bar pct={r.soldPct} />
                                </TD>
                                <TD>
                                  <span style={{ fontWeight: 500 }}>{r.name}</span>
                                </TD>
                                <TD right>{r.ordered > 0 ? fmt(r.ordered) : ""}</TD>
                                <TD right>{r.orderedCost > 0 ? fmt(r.orderedCost) : ""}</TD>
                                <TD right>{r.received > 0 ? fmt(r.received) : ""}</TD>
                                <TD right>{r.cost > 0 ? fmt(r.cost) : ""}</TD>
                                <TD right>{r.sold > 0 ? fmt(r.sold) : ""}</TD>
                                <TD right>
                                  <PctBadge pct={r.recPct} zero={zero} />
                                </TD>
                                <TD right>
                                  <PctBadge pct={r.soldPct} zero={zero} />
                                </TD>
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
            <button
              style={s.backBtn}
              onClick={function () {
                setScreen(currentVendor && currentVendor.allDepts ? "summary" : "vendors");
              }}
            >
              ←{" "}
              {currentVendor && currentVendor.allDepts
                ? "Store Summary"
                : currentDept
                  ? currentDept.name
                  : ""}
            </button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button
                onClick={function () {
                  setScreen("summary");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#3a5a8c",
                  cursor: "pointer",
                  fontFamily: "'DM Sans',sans-serif",
                  fontSize: 13,
                  textDecoration: "underline",
                  textUnderlineOffset: 2,
                  padding: 0,
                }}
              >
                Store Summary
              </button>
              {currentVendor && !currentVendor.allDepts && (
                <>
                  {" › "}
                  <button
                    onClick={function () {
                      setScreen("vendors");
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#3a5a8c",
                      cursor: "pointer",
                      fontFamily: "'DM Sans',sans-serif",
                      fontSize: 13,
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                      padding: 0,
                    }}
                  >
                    {currentDept ? currentDept.name : ""}
                  </button>
                </>
              )}
              {" › "}
              <span style={{ color: "#1a1816", fontWeight: 500 }}>
                {currentVendor ? currentVendor.name : ""}
              </span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1.25rem" }}>
              {[
                { label: "Ordered (retail)", value: fmt(productTotals.orderedRetail) },
                { label: "Ordered (cost)", value: fmt(productTotals.orderedCost) },
                {
                  label: "Received (retail)",
                  value: fmt(productTotals.receivedRetail),
                  sub:
                    productTotals.orderedRetail > 0
                      ? (
                          (productTotals.receivedRetail / productTotals.orderedRetail) *
                          100
                        ).toFixed(1) + "% of ordered"
                      : "0.0% of ordered",
                },
                { label: "Received (cost)", value: fmt(Math.max(0, productTotals.receivedCost)) },
                { label: "Returned (retail)", value: fmt(productTotals.returnedRetail) },
                {
                  label: "Sold (retail)",
                  value: fmt(productTotals.soldRetail),
                  sub:
                    productTotals.receivedRetail > 0
                      ? ((productTotals.soldRetail / productTotals.receivedRetail) * 100).toFixed(
                          1
                        ) + "% of received"
                      : "0.0% of received",
                },
                { label: "SKUs", value: productRows.length },
              ].map(function (kv) {
                return (
                  <div
                    key={kv.label}
                    style={{
                      background: "#fff",
                      border: "1px solid #e2ddd5",
                      borderRadius: 6,
                      padding: "7px 13px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: "#9e9892",
                        marginBottom: 2,
                      }}
                    >
                      {kv.label}
                    </div>
                    <div style={{ fontWeight: 600, color: "#1a1816" }}>{kv.value}</div>
                    {kv.sub && (
                      <div style={{ fontSize: 11, color: "#6b6560", marginTop: 2 }}>{kv.sub}</div>
                    )}
                  </div>
                );
              })}
            </div>
            {productLoading && <Spinner label="Loading products…" />}
            {productError && <ErrBox msg={productError} />}
            {!productLoading && (
              <TableWrap
                title={
                  (currentDept ? currentDept.name : "") +
                  " — " +
                  (currentVendor ? currentVendor.name : "")
                }
                right={
                  <div
                    style={{
                      display: "flex",
                      gap: 14,
                      flexWrap: "wrap",
                      alignItems: "center",
                      fontSize: 12,
                    }}
                  >
                    {["ordered", "stock", "sold", "sale", "returned"].map(function (st) {
                      const b = productBuckets[st];
                      return (
                        <span
                          key={st}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            color: "#6b6560",
                          }}
                        >
                          <span
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: "50%",
                              background: BUCKET_COLORS[st],
                              display: "inline-block",
                              flexShrink: 0,
                            }}
                          />
                          {BUCKET_LABELS[st]}
                          {b.n > 0 && (
                            <span style={{ fontWeight: 600 }}>
                              &nbsp;{b.n} — {fmt(b.v)}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                }
              >
                {(function () {
                  const handleSort = function (col) {
                    setProductSort(function (prev) {
                      return prev.col === col ? { col, dir: prev.dir * -1 } : { col, dir: -1 };
                    });
                  };
                  const sortVal = function (p, col) {
                    if (col === "name") return (p.name || "").toLowerCase();
                    if (col === "sku") return (p.sku || "").toLowerCase();
                    if (col === "variant") return (p.variant || "").toLowerCase();
                    if (col === "cost") return p.cost || 0;
                    if (col === "price") return p.price || 0;
                    if (col === "qtyOrdered") return p.qtyOrdered || 0;
                    if (col === "onHand") return p.onHand || 0;
                    if (col === "sold") return p.sold || 0;
                    if (col === "onSale") return p.onSale || 0;
                    if (col === "returned") return p.returned || 0;
                    return 0;
                  };
                  const sorted = productSort.col
                    ? productRows.slice().sort(function (a, b) {
                        const av = sortVal(a, productSort.col),
                          bv = sortVal(b, productSort.col);
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
                            <SortTH col="name" sort={sh} onSort={handleSort}>
                              Description
                            </SortTH>
                            <SortTH col="sku" sort={sh} onSort={handleSort}>
                              SKU
                            </SortTH>
                            <SortTH col="variant" sort={sh} onSort={handleSort}>
                              Variant
                            </SortTH>
                            <SortTH col="cost" sort={sh} onSort={handleSort} right>
                              Cost
                            </SortTH>
                            <SortTH col="price" sort={sh} onSort={handleSort} right>
                              Price
                            </SortTH>
                            <SortTH col="qtyOrdered" sort={sh} onSort={handleSort} right>
                              Ordered
                            </SortTH>
                            <SortTH col="onHand" sort={sh} onSort={handleSort} right>
                              On Hand
                            </SortTH>
                            <SortTH col="sold" sort={sh} onSort={handleSort} right>
                              Sold
                            </SortTH>
                            <SortTH col="onSale" sort={sh} onSort={handleSort} right>
                              On Sale
                            </SortTH>
                            <SortTH col="returned" sort={sh} onSort={handleSort} right>
                              Returned
                            </SortTH>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.length === 0 ? (
                            <tr>
                              <td
                                colSpan={11}
                                style={{ padding: "2.5rem", textAlign: "center", color: "#9e9892" }}
                              >
                                No products found for this vendor in the selected season.
                              </td>
                            </tr>
                          ) : (
                            sorted.map(function (p, i) {
                              return (
                                <tr key={i} style={{ borderBottom: "1px solid #e2ddd5" }}>
                                  <TD>
                                    <span
                                      style={{
                                        display: "flex",
                                        gap: 2,
                                        flexWrap: "wrap",
                                        maxWidth: 36,
                                      }}
                                    >
                                      {s.statusDots(p).map(function (c, di) {
                                        return (
                                          <span
                                            key={di}
                                            style={{
                                              width: 6,
                                              height: 14,
                                              borderRadius: 2,
                                              background: c,
                                              display: "inline-block",
                                              flexShrink: 0,
                                            }}
                                          />
                                        );
                                      })}
                                    </span>
                                  </TD>
                                  <TD>
                                    <span
                                      title={p.name}
                                      style={{
                                        display: "block",
                                        maxWidth: 260,
                                        overflow: "hidden",
                                        whiteSpace: "nowrap",
                                        textOverflow: "ellipsis",
                                      }}
                                    >
                                      {p.name}
                                    </span>
                                  </TD>
                                  <TD mono>{p.sku}</TD>
                                  <TD>
                                    <span style={{ color: "#6b6560" }}>{p.variant}</span>
                                  </TD>
                                  <TD right>{p.cost > 0 ? fmt(p.cost) : ""}</TD>
                                  <TD right>{p.price > 0 ? fmt(p.price) : ""}</TD>
                                  <TD right>{p.qtyOrdered > 0 ? p.qtyOrdered : ""}</TD>
                                  <TD right>
                                    {p.onHand > 0 ? p.onHand : ""}
                                    {p.inventoryMismatch && (
                                      <span
                                        title={
                                          "LS inventory: " +
                                          (p.liveOnHand ?? "unknown") +
                                          " (derived flow stock differs)"
                                        }
                                        style={{ color: "#92600a", marginLeft: 4, fontWeight: 700 }}
                                      >
                                        !=
                                      </span>
                                    )}
                                  </TD>
                                  <TD right>{p.sold > 0 ? p.sold : ""}</TD>
                                  <TD right style={{ color: "#6c3483" }}>
                                    {p.onSale > 0 ? p.onSale : ""}
                                  </TD>
                                  <TD right style={{ color: "#000000" }}>
                                    {p.returned > 0 ? p.returned : ""}
                                  </TD>
                                </tr>
                              );
                            })
                          )}
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
            Select a department from the <strong>flow summary</strong> tab to drill into vendor and
            product detail.
          </div>
        )}
      </div>
    </div>
  );
}
