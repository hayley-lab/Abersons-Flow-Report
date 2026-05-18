// pages/index.js
import { useState, useEffect, useCallback } from "react";

// ── helpers ───────────────────────────────────────────────────────────────────
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
  <th style={{ padding: "8px 12px", textAlign: right ? "right" : "left", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#6b6560", whiteSpace: "nowrap", background: "#f0ede6", borderBottom: "1px solid #e2ddd5" }}>
    {children}
  </th>
);

const TD = ({ children, right, mono }) => (
  <td style={{ padding: "9px 12px", textAlign: right ? "right" : "left", fontVariantNumeric: right ? "tabular-nums" : "normal", fontFamily: mono ? "monospace" : "inherit", fontSize: mono ? 12 : 13, color: mono ? "#6b6560" : "#1a1816", verticalAlign: "middle" }}>
    {children}
  </td>
);

// ── demo data ─────────────────────────────────────────────────────────────────
const DEMO_SUMMARY = [
  { id: "acc", name: "Accessories", ordered: 101823, received: 98413, sold: 55410 },
  { id: "alley", name: "Alley", ordered: 922276, received: 904549, sold: 604999 },
  { id: "alt", name: "Alterations", ordered: 0, received: 0, sold: 0 },
  { id: "denim", name: "Denim", ordered: 69531, received: 68231, sold: 45600 },
  { id: "des", name: "Designer", ordered: 306105, received: 282960, sold: 149860 },
  { id: "gc", name: "Gift Certificates", ordered: 0, received: 0, sold: 0 },
  { id: "hg", name: "Home Gifts", ordered: 0, received: 0, sold: 0 },
  { id: "mens", name: "Mens", ordered: 472591, received: 428733, sold: 240091 },
  { id: "next", name: "Next", ordered: 617680, received: 588475, sold: 452816 },
  { id: "season", name: "Season", ordered: 0, received: 0, sold: 0 },
  { id: "ship", name: "Shipping", ordered: 0, received: 0, sold: 0 },
  { id: "shoes", name: "Shoes", ordered: 329474, received: 293793, sold: 164143 },
];

const DEMO_VENDORS = {
  acc: [
    { id: "dk", name: "Dana Kellin", ordered: 31048, received: 31048, sold: 17854 },
    { id: "jp", name: "Judi Powers", ordered: 30280, received: 30280, sold: 15100 },
    { id: "re", name: "Rene Escobar", ordered: 40305, received: 36895, sold: 19866 },
    { id: "vale", name: "Vale", ordered: 1830, received: 1830, sold: 1830 },
  ],
  alley: [
    { id: "rag", name: "Rag & Bone", ordered: 210500, received: 207800, sold: 145000 },
    { id: "vince", name: "Vince", ordered: 189600, received: 185000, sold: 122300 },
    { id: "tb", name: "Theory", ordered: 145000, received: 142000, sold: 99800 },
    { id: "eis", name: "Eileen Fisher", ordered: 377176, received: 369749, sold: 237899 },
  ],
  denim: [
    { id: "ag", name: "AG Jeans", ordered: 35000, received: 34500, sold: 23400 },
    { id: "dl", name: "DL1961", ordered: 20531, received: 20231, sold: 14200 },
    { id: "mih", name: "MiH Jeans", ordered: 14000, received: 13500, sold: 8000 },
  ],
  des: [
    { id: "akris", name: "Akris", ordered: 89000, received: 82000, sold: 41000 },
    { id: "staud", name: "Staud", ordered: 72105, received: 67960, sold: 38860 },
    { id: "nili", name: "Nili Lotan", ordered: 145000, received: 133000, sold: 70000 },
  ],
  mens: [
    { id: "polo", name: "Ralph Lauren", ordered: 155000, received: 140000, sold: 78000 },
    { id: "boss", name: "Hugo Boss", ordered: 120000, received: 110000, sold: 62000 },
    { id: "pt01", name: "PT01 Trousers", ordered: 95000, received: 86000, sold: 48000 },
    { id: "sco", name: "Scott Barber", ordered: 102591, received: 92733, sold: 52091 },
  ],
  next: [
    { id: "vero", name: "Veronica Beard", ordered: 198000, received: 189000, sold: 152000 },
    { id: "mm", name: "M.M. LaFleur", ordered: 165000, received: 159000, sold: 124000 },
    { id: "wit", name: "Witchery", ordered: 254680, received: 240475, sold: 176816 },
  ],
  shoes: [
    { id: "cl", name: "Christian Louboutin", ordered: 98000, received: 87000, sold: 48000 },
    { id: "hw", name: "Hogl", ordered: 82000, received: 73000, sold: 42000 },
    { id: "laz", name: "Lavorazione Artigiana", ordered: 72000, received: 65000, sold: 37000 },
    { id: "sas", name: "SAS Shoes", ordered: 77474, received: 68793, sold: 37143 },
  ],
};

const DEMO_PRODUCTS = {
  dk: [
    { name: "dia 14k dia/14k", sku: "adc2726/pf2501", variant: "dia/14k", cost: 825, price: 2063, onHand: 0, sold: 1 },
    { name: "dia sil 14k", sku: "adc2806s/pf2501", variant: "dia/sil/14k", cost: 350, price: 875, onHand: 1, sold: 0 },
    { name: "ear kyanite 14k", sku: "ade2939/f2501", variant: "14k/kyanite", cost: 1075, price: 2688, onHand: 1, sold: 0 },
    { name: "ear tahitian pearl 14k", sku: "ade2058/f2501", variant: "14k", cost: 526, price: 1315, onHand: 1, sold: 0 },
    { name: "neck 14k", sku: "adc266/f2501", variant: "14k", cost: 476, price: 1190, onHand: 1, sold: 0 },
    { name: "neck sunstone 14k", sku: "adc2953/f2501", variant: "14k/sunstone", cost: 1475, price: 3688, onHand: 1, sold: 0 },
  ],
};

// ── API fetch helpers (go through our proxy) ──────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`/api/ls/${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiFetchAll(path, key) {
  let results = [];
  let after = null;
  let pages = 0;
  while (pages < 20) {
    pages++;
    const sep = path.includes("?") ? "&" : "?";
    const fullPath = path + sep + "page_size=200" + (after ? "&after=" + after : "");
    const data = await apiFetch(fullPath);
    const items = data[key] || data.data || [];
    results = results.concat(items);
    if (items.length === 0) break;
    // Standard cursor pagination
    const pg = data.pagination || data.meta?.pagination;
    if (pg?.next) { after = pg.next; continue; }
    // Version-based pagination: if full page, use version.max as cursor
    if (items.length === 200 && data.version?.max) { after = data.version.max; continue; }
    break;
  }
  return results;
}

// ── main component ────────────────────────────────────────────────────────────
export default function FlowReport() {
  const [demo, setDemo] = useState(false);
  const [screen, setScreen] = useState("summary");
  const [season, setSeason] = useState("fall2025");
  const [seasons] = useState([
    { id: "fall2025", name: "fall 2025" },
    { id: "spring2025", name: "spring 2025" },
  ]);
  const [summaryRows, setSummaryRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentDept, setCurrentDept] = useState(null);
  const [vendorRows, setVendorRows] = useState([]);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorError, setVendorError] = useState(null);
  const [currentVendor, setCurrentVendor] = useState(null);
  const [productRows, setProductRows] = useState([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productError, setProductError] = useState(null);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSummaryRows([]);

    if (demo) {
      setSummaryRows(DEMO_SUMMARY);
      setLoading(false);
      return;
    }

    try {
      const [cats, products, consignments] = await Promise.all([
        apiFetchAll("2.0/product_types", "data"),
        apiFetchAll("2.0/products", "data"),
        apiFetchAll("2.0/consignments?type=SUPPLIER", "data"),
      ]);

      const map = {};
      cats.forEach((c) => {
        map[c.id] = { id: c.id, name: c.name, ordered: 0, received: 0, sold: 0 };
      });
      const pidTocat = {};
      products.forEach((p) => {
        const cid = p.product_type_id || "__none__";
        pidTocat[p.id] = cid;
        if (!map[cid]) map[cid] = { id: cid, name: "Other", ordered: 0, received: 0, sold: 0 };
      });

      // Fetch consignment products and sales in parallel
      const [consigProductArrays, sales] = await Promise.all([
        Promise.all(consignments.map((c) => apiFetchAll(`2.0/consignments/${c.id}/products`, "data"))),
        apiFetchAll("2.0/sales?include=line_items", "data"),
      ]);

      consigProductArrays.flat().forEach((item) => {
        const cid = pidTocat[item.product_id] || "__none__";
        if (!map[cid]) return;
        const unitCost = parseFloat(item.cost || 0);
        map[cid].ordered += unitCost * (item.count || 0);
        map[cid].received += unitCost * (item.received || 0);
      });

      sales.forEach((sale) => {
        (sale.line_items || []).forEach((li) => {
          if (li.type !== "register_sale_product") return;
          const cid = pidTocat[li.product_id] || "__none__";
          if (!map[cid]) return;
          map[cid].sold += parseFloat(li.total_price || li.price || 0);
        });
      });

      setSummaryRows(Object.values(map).sort((a, b) => b.ordered - a.ordered));
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [demo]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const openDept = useCallback(
    async (dept) => {
      setCurrentDept(dept);
      setVendorRows([]);
      setVendorLoading(true);
      setVendorError(null);
      setScreen("vendors");

      if (demo) {
        setVendorRows(DEMO_VENDORS[dept.id] || []);
        setVendorLoading(false);
        return;
      }

      try {
        const [products, consignments] = await Promise.all([
          apiFetchAll(`2.0/products?product_type_id=${dept.id}`, "data"),
          apiFetchAll("2.0/consignments?type=SUPPLIER", "data"),
        ]);

        const vm = {};
        const pidToBrand = {};
        products.forEach((p) => {
          const bid = p.brand_id || p.supplier_id || "__none__";
          const name = p.brand?.name || p.supplier?.name || "Unknown";
          pidToBrand[p.id] = bid;
          if (!vm[bid]) vm[bid] = { id: bid, name, ordered: 0, received: 0, sold: 0 };
        });

        const [consigProductArrays, sales] = await Promise.all([
          Promise.all(consignments.map((c) => apiFetchAll(`2.0/consignments/${c.id}/products`, "data"))),
          apiFetchAll("2.0/sales?include=line_items", "data"),
        ]);

        consigProductArrays.flat().forEach((item) => {
          const bid = pidToBrand[item.product_id];
          if (!bid || !vm[bid]) return;
          const unitCost = parseFloat(item.cost || 0);
          vm[bid].ordered += unitCost * (item.count || 0);
          vm[bid].received += unitCost * (item.received || 0);
        });

        sales.forEach((sale) => {
          (sale.line_items || []).forEach((li) => {
            if (li.type !== "register_sale_product") return;
            const bid = pidToBrand[li.product_id];
            if (!bid || !vm[bid]) return;
            vm[bid].sold += parseFloat(li.total_price || li.price || 0);
          });
        });

        setVendorRows(Object.values(vm).sort((a, b) => b.ordered - a.ordered));
      } catch (e) {
        setVendorError(e.message);
      }
      setVendorLoading(false);
    },
    [demo]
  );

  const openVendor = useCallback(
    async (vendor) => {
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
        const [products, sales] = await Promise.all([
          apiFetchAll(`2.0/products?brand_id=${vendor.id}&product_type_id=${currentDept.id}`, "data"),
          apiFetchAll("2.0/sales?include=line_items", "data"),
        ]);

        const pidSet = new Set(products.map((p) => p.id));
        const soldMap = {};
        sales.forEach((s) =>
          (s.line_items || []).forEach((li) => {
            if (li.type !== "register_sale_product" || !pidSet.has(li.product_id)) return;
            soldMap[li.product_id] = (soldMap[li.product_id] || 0) + parseInt(li.quantity || 1);
          })
        );
        setProductRows(
          products.map((p) => ({
            name: p.name,
            sku: p.sku || "",
            variant: p.variant_option_one_value || p.variant_name || "",
            cost: parseFloat(p.supply_price || p.cost_price || 0),
            price: parseFloat(p.price_excluding_tax || p.price || 0),
            onHand: p.inventory?.count ?? p.inventory_count ?? 0,
            sold: soldMap[p.id] || 0,
          }))
        );
      } catch (e) {
        setProductError(e.message);
      }
      setProductLoading(false);
    },
    [demo, currentDept]
  );

  const totalOrdered = summaryRows.reduce((a, r) => a + r.ordered, 0);
  const totalReceived = summaryRows.reduce((a, r) => a + r.received, 0);
  const totalSold = summaryRows.reduce((a, r) => a + r.sold, 0);
  const totalRecPct = totalOrdered > 0 ? (totalReceived / totalOrdered) * 100 : 0;
  const totalSoldPct = totalReceived > 0 ? (totalSold / totalReceived) * 100 : 0;

  const vTotalOrdered = vendorRows.reduce((a, r) => a + r.ordered, 0);
  const vTotalReceived = vendorRows.reduce((a, r) => a + r.received, 0);
  const vTotalSold = vendorRows.reduce((a, r) => a + r.sold, 0);

  const s = {
    app: { fontFamily: "'DM Sans',sans-serif", background: "#f7f5f0", minHeight: "100vh", fontSize: 14 },
    header: { background: "#fff", borderBottom: "1px solid #e2ddd5", padding: "0 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
    logo: { fontFamily: "'DM Serif Display',serif", fontSize: 22, color: "#1a1816", letterSpacing: -0.5 },
    nav: { display: "flex", gap: 4 },
    navBtn: (active) => ({ background: active ? "#e8eef7" : "none", border: "none", padding: "6px 13px", borderRadius: 6, fontSize: 13, color: active ? "#3a5a8c" : "#6b6560", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }),
    main: { padding: "1.75rem 1.5rem", maxWidth: 1100, margin: "0 auto" },
    seasonPill: { display: "flex", alignItems: "center", gap: 6, background: "#f0ede6", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 10px", fontSize: 13, fontWeight: 500 },
    tableRow: (clickable, zero) => ({ borderBottom: "1px solid #e2ddd5", cursor: clickable && !zero ? "pointer" : "default", opacity: zero ? 0.45 : 1, transition: "background 0.1s" }),
    backBtn: { background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, textDecoration: "underline", textUnderlineOffset: 2, padding: 0, marginBottom: "0.9rem" },
    demoBadge: { background: "#fef3e2", color: "#92600a", border: "1px solid #f5d9a0", borderRadius: 20, fontSize: 11, fontWeight: 600, padding: "3px 10px", letterSpacing: "0.04em" },
    statusDot: (status) => {
      const colors = { sold: "#4a7ab5", stock: "#e05a36", ordered: "#aaa" };
      return { width: 10, height: 10, borderRadius: "50%", background: colors[status] || "#aaa", display: "inline-block" };
    },
  };

  // ── Main app ──
  return (
    <div style={s.app}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500;600&display=swap'); @keyframes spin{to{transform:rotate(360deg)}} tbody tr:hover{background:#f0f5fb!important}`}</style>

      <header style={s.header}>
        <div style={s.logo}>abersons</div>
        <nav style={s.nav}>
          <button style={s.navBtn(screen === "summary" || screen === "vendors" || screen === "products")} onClick={() => setScreen("summary")}>
            flow summary
          </button>
          <button style={s.navBtn(screen === "detail")} onClick={() => setScreen("detail")}>
            flow detail
          </button>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {demo && <span style={s.demoBadge}>demo mode</span>}
          <div style={s.seasonPill}>
            <span style={{ color: "#9e9892", fontSize: 12 }}>▸</span>
            <select
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              style={{ background: "none", border: "none", fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, color: "#1a1816", cursor: "pointer", outline: "none" }}
            >
              {seasons.map((s2) => (
                <option key={s2.id} value={s2.id}>{s2.name}</option>
              ))}
            </select>
            <span style={{ color: "#9e9892", fontSize: 12 }}>◂</span>
          </div>
          <button onClick={() => setDemo(!demo)} style={{ background: "none", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 11px", fontSize: 12, color: "#6b6560", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            {demo ? "Live data" : "Demo mode"}
          </button>
        </div>
      </header>

      <div style={s.main}>
        {/* SUMMARY */}
        {screen === "summary" && (
          <>
            {loading && <Spinner label="Loading store summary…" />}
            {error && <ErrBox msg={error} />}
            {!loading && (
              <>
                <KpiRow items={[
                  { label: "Total Ordered", value: fmt(totalOrdered) },
                  { label: "Total Received", value: fmt(totalReceived), sub: `${totalRecPct.toFixed(1)}% of ordered` },
                  { label: "Total Sold", value: fmt(totalSold), sub: `${totalSoldPct.toFixed(1)}% of received` },
                  { label: "Departments", value: summaryRows.filter((r) => r.ordered > 0 || r.sold > 0).length },
                ]} />
                <TableWrap
                  title="Store Summary"
                  right={
                    <button onClick={loadSummary} style={{ background: "none", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 11px", fontSize: 12, fontWeight: 500, color: "#6b6560", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                      ↺ Refresh
                    </button>
                  }
                >
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <TH>Sold %</TH>
                        <TH>Department</TH>
                        <TH right>Ordered</TH>
                        <TH right>Received</TH>
                        <TH right>Sold</TH>
                        <TH right>Received %</TH>
                        <TH right>Sold %</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRows.map((r) => {
                        const recPct = r.ordered > 0 ? (r.received / r.ordered) * 100 : 0;
                        const soldPct = r.received > 0 ? (r.sold / r.received) * 100 : 0;
                        const zero = r.ordered === 0 && r.sold === 0;
                        return (
                          <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={() => !zero && openDept(r)}>
                            <TD><Bar pct={soldPct} /></TD>
                            <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                            <TD right>{fmt(r.ordered)}</TD>
                            <TD right>{fmt(r.received)}</TD>
                            <TD right>{fmt(r.sold)}</TD>
                            <TD right><PctBadge pct={recPct} zero={zero} /></TD>
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

        {/* VENDORS */}
        {screen === "vendors" && (
          <>
            <button style={s.backBtn} onClick={() => setScreen("summary")}>← Store Summary</button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button onClick={() => setScreen("summary")} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>
                Store Summary
              </button>
              {" › "}<span style={{ color: "#1a1816", fontWeight: 500 }}>{currentDept?.name}</span>
            </div>
            {vendorLoading && <Spinner label="Loading vendors…" />}
            {vendorError && <ErrBox msg={vendorError} />}
            {!vendorLoading && (
              <>
                <KpiRow items={[
                  { label: "Ordered", value: fmt(vTotalOrdered) },
                  { label: "Received", value: fmt(vTotalReceived), sub: vTotalOrdered > 0 ? `${((vTotalReceived / vTotalOrdered) * 100).toFixed(1)}%` : "—" },
                  { label: "Sold", value: fmt(vTotalSold), sub: vTotalReceived > 0 ? `${((vTotalSold / vTotalReceived) * 100).toFixed(1)}%` : "—" },
                  { label: "Vendors", value: vendorRows.filter((r) => r.ordered > 0 || r.sold > 0).length },
                ]} />
                <TableWrap title={`${currentDept?.name} — by Vendor`}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <TH>Sold %</TH>
                        <TH>Vendor</TH>
                        <TH right>Ordered</TH>
                        <TH right>Received</TH>
                        <TH right>Sold</TH>
                        <TH right>Received %</TH>
                        <TH right>Sold %</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorRows.map((r) => {
                        const recPct = r.ordered > 0 ? (r.received / r.ordered) * 100 : 0;
                        const soldPct = r.received > 0 ? (r.sold / r.received) * 100 : 0;
                        const zero = r.ordered === 0 && r.sold === 0;
                        return (
                          <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={() => !zero && openVendor(r)}>
                            <TD><Bar pct={soldPct} /></TD>
                            <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                            <TD right>{fmt(r.ordered)}</TD>
                            <TD right>{fmt(r.received)}</TD>
                            <TD right>{fmt(r.sold)}</TD>
                            <TD right><PctBadge pct={recPct} zero={zero} /></TD>
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

        {/* PRODUCTS */}
        {screen === "products" && (
          <>
            <button style={s.backBtn} onClick={() => setScreen("vendors")}>← {currentDept?.name}</button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button onClick={() => setScreen("summary")} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>
                Store Summary
              </button>
              {" › "}
              <button onClick={() => setScreen("vendors")} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>
                {currentDept?.name}
              </button>
              {" › "}<span style={{ color: "#1a1816", fontWeight: 500 }}>{currentVendor?.name}</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1.25rem" }}>
              {[{ label: "Ordered", value: fmt(currentVendor?.ordered || 0) }, { label: "Received", value: fmt(currentVendor?.received || 0) }, { label: "Sold", value: fmt(currentVendor?.sold || 0) }, { label: "SKUs", value: productRows.length }].map(({ label, value }) => (
                <div key={label} style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 6, padding: "7px 13px" }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9e9892", marginBottom: 2 }}>{label}</div>
                  <div style={{ fontWeight: 600, color: "#1a1816" }}>{value}</div>
                </div>
              ))}
            </div>
            {productLoading && <Spinner label="Loading products…" />}
            {productError && <ErrBox msg={productError} />}
            {!productLoading && (
              <TableWrap title={`${currentDept?.name} — ${currentVendor?.name}`}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <TH>Status</TH>
                      <TH>Description</TH>
                      <TH>SKU</TH>
                      <TH>Variant</TH>
                      <TH right>Cost</TH>
                      <TH right>Price</TH>
                      <TH right>On Hand</TH>
                      <TH right>Sold</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.length === 0 ? (
                      <tr><td colSpan={8} style={{ padding: "2.5rem", textAlign: "center", color: "#9e9892" }}>No products found.</td></tr>
                    ) : (
                      productRows.map((p, i) => {
                        const status = p.sold > 0 ? "sold" : p.onHand > 0 ? "stock" : "ordered";
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid #e2ddd5" }}>
                            <TD><span style={s.statusDot(status)} /></TD>
                            <TD>{p.name}</TD>
                            <TD mono>{p.sku}</TD>
                            <TD><span style={{ color: "#6b6560" }}>{p.variant}</span></TD>
                            <TD right>{p.cost > 0 ? fmt(p.cost) : "—"}</TD>
                            <TD right>{p.price > 0 ? fmt(p.price) : "—"}</TD>
                            <TD right>{p.onHand}</TD>
                            <TD right>{p.sold}</TD>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "9px 12px", background: "#f0ede6", borderTop: "1px solid #e2ddd5", fontSize: 12 }}>
                  {[["sold", "sold", "#4a7ab5"], ["stock", "in stock", "#e05a36"], ["ordered", "ordered", "#aaa"]].map(([key, label, color]) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 5, color: "#6b6560" }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, display: "inline-block" }} />
                      {label}
                    </div>
                  ))}
                </div>
              </TableWrap>
            )}
          </>
        )}

        {/* DETAIL placeholder */}
        {screen === "detail" && (
          <div style={{ color: "#6b6560", marginTop: "1rem" }}>
            Select a department from the <strong>flow summary</strong> tab to drill into vendor and product detail.
          </div>
        )}
      </div>
    </div>
  );
}
