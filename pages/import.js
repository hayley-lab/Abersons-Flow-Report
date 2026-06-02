// pages/import.js — Admin import tool for old datatail seasons
import { useState } from "react";

const SEASONS_MAP = {
  fall25:    ["fall 2025", "fall25"],
  spring25:  ["spring 2025", "spring25"],
};

export default function ImportPage() {
  const [phpsessid,   setPhpsessid]   = useState("");
  const [rememberme,  setRememberme]  = useState("");
  const [status,      setStatus]      = useState(null);
  const [probeResult, setProbeResult] = useState(null);
  const [vendors,     setVendors]     = useState([]);
  const [log,         setLog]         = useState([]);
  const [running,     setRunning]     = useState(false);
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
    const result = await post({ action: "probe", phpsessid, rememberme });
    setProbeResult(result);
    if (result.ok) {
      setStatus("Connected! Detected seasons: " + (result.seasons.join(", ") || "none found"));
    } else {
      setStatus("Error: " + (result.error || "unknown"));
    }
  }

  async function handleFetchVendors() {
    setStatus("Fetching vendor index…");
    setLog([]);
    const result = await post({ action: "fetchVendorIndex", phpsessid, rememberme });
    if (result.ok) {
      setVendors(result.vendors);
      setStatus(`Found ${result.vendors.length} vendor/department combinations.`);
      addLog(`Vendor index: ${result.vendors.length} entries`);
    } else {
      setStatus("Error: " + result.error);
    }
  }

  async function handleImportAll() {
    if (vendors.length === 0) {
      setStatus("Fetch vendor list first.");
      return;
    }
    setRunning(true);
    setLog([]);
    addLog(`Starting import for ${vendors.length} vendor/dept pages…`);

    const allData = {};
    for (let i = 0; i < vendors.length; i++) {
      const v = vendors[i];
      addLog(`[${i + 1}/${vendors.length}] ${v.vendorName} (vendor ${v.vendorId}, dept ${v.deptId})…`);
      try {
        const result = await post({
          action: "fetchVendorDetail",
          phpsessid,
          rememberme,
          vendorId: v.vendorId,
          deptId: v.deptId,
        });
        if (result.ok) {
          const key = `${v.deptId}__${v.vendorId}`;
          allData[key] = {
            vendorId:   v.vendorId,
            vendorName: v.vendorName,
            deptId:     v.deptId,
            ordered:    result.ordered,
            received:   result.received,
            sold:       result.sold,
            products:   result.products,
          };
          addLog(`  ✓ ordered=${result.ordered} received=${result.received} sold=${result.sold} products=${result.products.length}`);
        } else {
          addLog(`  ✗ Error: ${result.error}`);
        }
      } catch (err) {
        addLog(`  ✗ Exception: ${err.message}`);
      }
      // Small delay to avoid hammering the old server
      await new Promise(r => setTimeout(r, 300));
    }

    // Save to KV via a save endpoint
    addLog("Saving to KV…");
    const saveRes = await fetch("/api/import/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ season: targetSeason, data: allData }),
    });
    const saved = await saveRes.json();
    if (saved.ok) {
      addLog(`Done! Saved override data for ${targetSeason}.`);
      setStatus(`Import complete for ${targetSeason}.`);
    } else {
      addLog("Save failed: " + saved.error);
      setStatus("Import failed at save step.");
    }
    setRunning(false);
  }

  const inp = {
    width: "100%",
    fontFamily: "monospace",
    fontSize: 12,
    padding: "6px 8px",
    border: "1px solid #d0ccc5",
    borderRadius: 6,
    background: "#fafaf8",
    boxSizing: "border-box",
  };

  const btn = (disabled) => ({
    padding: "8px 18px",
    background: disabled ? "#e0ddd8" : "#3a5a8c",
    color: disabled ? "#999" : "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    fontFamily: "'DM Sans', sans-serif",
  });

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1rem", fontFamily: "'DM Sans', sans-serif", fontSize: 14 }}>
      <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, marginBottom: "0.25rem" }}>Import from Old Report</h1>
      <p style={{ color: "#9e9892", fontSize: 13, marginBottom: "2rem" }}>
        Pulls Spring/Fall 2025 data from datatailor.abersonstyle.com and stores it as override data in KV.
      </p>

      <div style={{ background: "#fff8e8", border: "1px solid #f0d080", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1.5rem", fontSize: 12, color: "#7a5a00" }}>
        <strong>How to get your cookies:</strong> Open datatailor.abersonstyle.com → DevTools → Application → Cookies →
        click each cookie name and copy its Value. Paste below. Your cookies are sent only to your own server and never stored.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: "1.5rem" }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>
            PHPSESSID value
          </label>
          <input style={inp} type="password" value={phpsessid} onChange={e => setPhpsessid(e.target.value)} placeholder="paste cookie value…" />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>
            REMEMBERME value (recommended — lasts longer)
          </label>
          <input style={inp} type="password" value={rememberme} onChange={e => setRememberme(e.target.value)} placeholder="paste cookie value…" />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 4 }}>
            Target season (where to save in our app)
          </label>
          <select value={targetSeason} onChange={e => setTargetSeason(e.target.value)} style={{ ...inp, fontFamily: "'DM Sans', sans-serif" }}>
            <option value="spring25">Spring 2025</option>
            <option value="fall25">Fall 2025</option>
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <button style={btn(!phpsessid && !rememberme)} disabled={!phpsessid && !rememberme} onClick={handleProbe}>
          1. Test Connection
        </button>
        <button style={btn(!probeResult?.ok)} disabled={!probeResult?.ok} onClick={handleFetchVendors}>
          2. Fetch Vendor List
        </button>
        <button style={btn(running || vendors.length === 0)} disabled={running || vendors.length === 0} onClick={handleImportAll}>
          3. Import All ({vendors.length} vendors)
        </button>
      </div>

      {status && (
        <div style={{ background: "#f0ede6", borderRadius: 8, padding: "0.6rem 1rem", marginBottom: "1rem", fontSize: 13, color: "#3a3530" }}>
          {status}
        </div>
      )}

      {log.length > 0 && (
        <div style={{ background: "#1a1816", borderRadius: 8, padding: "1rem", maxHeight: 400, overflowY: "auto" }}>
          {log.map((line, i) => (
            <div key={i} style={{ fontFamily: "monospace", fontSize: 12, color: line.includes("✓") ? "#7ec8a0" : line.includes("✗") ? "#f08080" : "#d0ccc5", lineHeight: 1.6 }}>
              {line}
            </div>
          ))}
        </div>
      )}

      {vendors.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6b6560", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Vendor List ({vendors.length})
          </div>
          <div style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 8, maxHeight: 200, overflowY: "auto" }}>
            {vendors.map((v, i) => (
              <div key={i} style={{ padding: "5px 12px", borderBottom: "1px solid #f0ede6", fontSize: 12, display: "flex", gap: 12 }}>
                <span style={{ color: "#9e9892", width: 60 }}>v{v.vendorId}/d{v.deptId}</span>
                <span>{v.vendorName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
