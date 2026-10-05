// Upstash usage tracking for cost work. Upstash bills on commands and bandwidth,
// but its INFO only exposes cumulative command counters, so we snapshot them
// over time and diff consecutive snapshots into per-interval rates.

const FIELDS = {
  total_commands_processed: "commands",
  total_reads_processed: "reads",
  total_writes_processed: "writes",
  total_data_size: "dataBytes",
  total_keys: "keys",
};

// Parse the counters we track out of a Redis/Upstash INFO text blob.
export function parseRedisInfo(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = FIELDS[line.slice(0, idx)];
    if (!name) continue;
    const value = Number(line.slice(idx + 1).trim());
    if (Number.isFinite(value)) out[name] = value;
  }
  return out;
}

// Turn time-ordered snapshots ({ ts, commands, reads, writes, ... }) into
// per-interval deltas normalised to a 24h rate. A counter that goes backwards
// means Upstash reset it (failover/restart), so that interval is flagged rather
// than reported as a negative rate.
export function usageDeltas(snapshots) {
  const sorted = [...(snapshots || [])].sort((a, b) => a.ts - b.ts);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const hours = (b.ts - a.ts) / 3600000;
    if (hours <= 0) continue;
    const d = (k) => (b[k] ?? 0) - (a[k] ?? 0);
    const reset = d("commands") < 0 || d("reads") < 0 || d("writes") < 0;
    const perDay = (n) => (reset ? null : Math.round((n / hours) * 24));
    out.push({
      from: a.ts,
      to: b.ts,
      hours: Math.round(hours * 10) / 10,
      reset,
      commands: reset ? null : d("commands"),
      commandsPerDay: perDay(d("commands")),
      readsPerDay: perDay(d("reads")),
      writesPerDay: perDay(d("writes")),
      dataBytes: b.dataBytes ?? null,
    });
  }
  return out;
}
