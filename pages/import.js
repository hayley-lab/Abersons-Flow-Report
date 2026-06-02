// pages/import.js — Admin import tool for old datatail seasons
import { useState } from "react";

export default function ImportPage() {
  const [phpsessid,    setPhpsessid]    = useState("");
  const [rememberme,   setRememberme]   = useState("");
  const [status,       setStatus]       = useState(null);
  const [probeResult,  setProbeResult]  = useState(null);
  const [stores,       setStores]       = useState([]);
  const [vendors,      setVendors]      = useState([]);
  const [log,          setLog]          = useState([]);
  const [running,      setRunning]      = useState(false);
  const [targetSeason, setTargetSeason] = useState("spring25");

  function addLog(msg) {
    setLog(prev => [...prev, msg]);
  }

  async function post(body) {
    const r = await fetch("/api/import/datatail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function handleProbe() {
    setStatus("Checking cookies…");
    setProbeResult(null);
    setLog([]);
    setStores([]);
    setVendors([]);
    const result = await post({ action: "probe", phpsessid, rememberme });
    setProbeResult(result);
    if (result.ok) {
      setStatus(`Connected! Current season on old site: "${result.current}" (prev: ${result.prev}, next: ${result.next})`);
    } else {
      setStatus("Error: " + (result.error || "unknown"));
    }
  }

  async function handleFetchVendors() {
    setStatus("Step 1/2: Fetching store list…");
    setLog([]);
    setStores([]);
    setVendors([]);
    setRunning(false); // reset any stuck state from prior run

    const storesResult = await post({ action: "fetchStores", phpsessid, rememberme });
    if (!storesResult.ok) { setStatus("Error: " + storesResult.error); return; }
    const storeList = storesResult.stores.filter(s => s.ordered > 0 || s.sold > 0 || s.received > 0);
    setStores(storeList);
    addLog(`Found ${storeList.length} active stores: ${storeList.map(s => s.name).join(", ")}`);

    const allVendors = [];
    for (let i = 0; i < storeList.length; i++) {
      const st = storeList[i];
      setStatus(`Step 2/2: Fetching vendors for ${st.name} (${i + 1}/${storeList.length})…`);
      const vResult = await post({ action: "fetchStoreVendors", phpsessid, rememberme, storeId: st.id, storeName: st.name });
      if (vResult.ok) {
        addLog(`  ${st.name}: ${vResult.vendors.length} vendors`);
        allVendors.push(...vResult.vendors);
      } else {
        addLog(`  ${st.name}: ERROR — ${vResult.error}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    setVendors(allVendors);
    setStatus(`Ready to import: ${allVendors.length} vendor/department combinations across ${storeList.length} departments.`);
  }

  async function handleImportAll() {
    if (vendors.length === 0) { setStatus("Fetch vendor list first."); return; }
    setRunning(true);
    setLog([]);
    try { await doImport(); } finally { setRunning(false); }
  }

  async function doImport() {
    addLog(`Importing ${vendors.length} vendor/dept pages for ${targetSeason}…`);

    const allData = { stores: {}, vendors: {} };

    // Store store-level summary
    stores.forEach(s => {
      allData.stores[s.id] = { id: s.id, name: s.name, ordered: s.ordered, received: s.received, sold: s.sold };
    });

    for (let i = 0; i < vendors.length; i++) {
      const v = vendors[i];
      addLog(`[${i + 1}/${vendors.length}] ${v.storeName} › ${v.vendorName}…`);
      try {
        const result = await post({ action: "fetchVendorDetail", phpsessid, rememberme, vendorId: v.vendorId, deptId: v.deptId });
        if (result.ok) {
          const key = `${v.deptId}__${v.vendorId}`;
          allData.vendors[key] = {
            vendorId:   v.vendorId,
            vendorName: v.vendorName,
            deptId:     v.deptId,
            deptName:   v.storeName,
            ordered:    result.ordered  || v.ordered  || 0,
            received:   result.received || v.received || 0,
            sold:       result.sold     || v.sold     || 0,
            products:   result.products,
          };
          addLog(`  ✓ ${result.products.length} products, ordered=$${result.ordered}`);
        } else {
          addLog(`  ✗ ${result.error}`);
        }
      } catch (err) {
        addLog(`  ✗ ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    addLog("Saving to KV…");
    // Send in batches of 20 vendors to stay under request size limits
    const BATCH = 20;
    const vendorEntries = Object.entries(allData.vendors);
    let saved = 0;
    for (let b = 0; b < vendorEntries.length; b += BATCH) {
      const batchVendors = {};
      vendorEntries.slice(b, b + BATCH).forEach(([k, v]) => { batchVendors[k] = v; });
      const saveRes = await fetch("/api/import/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season: targetSeason, data: { stores: b === 0 ? allData.stores : {}, vendors: batchVendors } }),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.ok) {
        addLog(`✗ Save batch failed: ${saveJson.error}`);
        setStatus("Import failed at save step.");
        setRunning(false);
        return;
      }
      saved += Object.keys(batchVendors).length;
      addLog(`  Saved ${saved}/${vendorEntries.length} vendors…`);
    }
    addLog(`✓ Saved override data for ${targetSeason}. ${vendorEntries.length} vendors stored.`);
    setStatus(`Import complete for ${targetSeason}!`);
  }

  async function handleDebugHtml() {
    setStatus("Fetching raw HTML…");
    const result = await post({ action: "debugHtml", phpsessid, rememberme, path: "/" });
    if (result.ok) {
      setStatus("Raw HTML dumped to log (" + result.length + " chars total, showing first 8000)");
      addLog("=== RAW HTML ===");
      const chunk = 200;
      for (let i = 0; i < result.html.length; i += chunk) addLog(result.html.slice(i, i + chunk));
    } else {
      setStatus("Error: " + result.error);
    }
  }

  const inp = { width: "100%", fontFamily: "monospace", fontSize: 12, padding: "6px 8px", border: "1px solid #d0ccc5", borderRadius: 6, background: "#fafaf8", boxSizing: "border-box" };
  const btn = (disabled, bg) => ({ padding: "8px 18px", background: disabled ? "#e0ddd8" : (bg || "#3a5a8c"), color: disabled ? "#999" : "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: disabled ? "default" : "pointer", fontFamily: "'DM Sans', sans-serif" });

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", fontFamily: "'DM Sans', sans-serif", fontSize: 14 }}>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, marginBottom: "0.25rem" }}>Import from Old Report</h1>
      <p style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.5rem" }}>Pulls Spring/Fall 2025 data from datatailor.abersonstyle.com into KV.</p>

      <div style={{ background: "#fff8e8", border: "1px solid #f0d080", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1.5rem", fontSize: 12, color: "#7a5a00", lineHeight: 1.6 }}>
        <strong>Before importing:</strong> Navigate the old site to the correct season (Spring 2025 or Fall 2025) using its season arrows, then paste your cookies below.
        <br /><strong>To get cookies:</strong> DevTools → Application → Cookies → datatailor.abersonstyle.com → click each name, copy Value.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: "1.5rem" }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>PHPSESSID value</label>
          <input style={inp} type="password" value={phpsessid} onChange={e => setPhpsessid(e.target.value)} placeholder="paste cookie value…" />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>REMEMBERME value (recommended)</label>
          <input style={inp} type="password" value={rememberme} onChange={e => setRememberme(e.target.value)} placeholder="paste cookie value…" />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>Save imported data as</label>
          <select value={targetSeason} onChange={e => setTargetSeason(e.target.value)} style={{ ...inp, fontFamily: "'DM Sans', sans-serif" }}>
            <option value="spring25">Spring 2025</option>
            <option value="fall25">Fall 2025</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <button style={btn(!phpsessid && !rememberme)} disabled={!phpsessid && !rememberme} onClick={handleProbe}>1. Test Connection</button>
        <button style={btn(!probeResult?.ok)} disabled={!probeResult?.ok} onClick={handleFetchVendors}>2. Fetch Vendor List</button>
        <button style={btn(running || vendors.length === 0)} disabled={running || vendors.length === 0} onClick={handleImportAll}>3. Import All ({vendors.length})</button>
        <button style={btn(!probeResult?.ok, "#6b6560")} disabled={!probeResult?.ok} onClick={handleDebugHtml}>Debug HTML</button>
      </div>

      {status && (
        <div style={{ background: "#f0ede6", borderRadius: 8, padding: "0.6rem 1rem", marginBottom: "1rem", fontSize: 13, color: "#3a3530", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{status}</span>
          {running && <button onClick={() => setRunning(false)} style={{ background: "none", border: "1px solid #b0a898", borderRadius: 5, padding: "2px 10px", fontSize: 12, cursor: "pointer", color: "#6b6560" }}>Unlock</button>}
        </div>
      )}

      {log.length > 0 && (
        <div style={{ background: "#1a1816", borderRadius: 8, padding: "1rem", maxHeight: 400, overflowY: "auto" }}>
          {log.map((line, i) => (
            <div key={i} style={{ fontFamily: "monospace", fontSize: 12, color: line.includes("✓") ? "#7ec8a0" : line.includes("✗") ? "#f08080" : "#d0ccc5", lineHeight: 1.6 }}>{line}</div>
          ))}
        </div>
      )}

      {vendors.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Vendor List ({vendors.length})</div>
          <div style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 8, maxHeight: 200, overflowY: "auto" }}>
            {vendors.map((v, i) => (
              <div key={i} style={{ padding: "5px 12px", borderBottom: "1px solid #f0ede6", fontSize: 12, display: "flex", gap: 12 }}>
                <span style={{ color: "#9e9892", width: 80, flexShrink: 0 }}>{v.storeName}</span>
                <span>{v.vendorName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
