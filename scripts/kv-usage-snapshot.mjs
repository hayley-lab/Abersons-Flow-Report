#!/usr/bin/env node
/**
 * Upstash usage snapshot — cost baseline (Oct 2026).
 *
 * Appends the cumulative Upstash command counters to scripts/out/kv-usage.jsonl
 * and prints per-interval daily rates between snapshots. Run it daily (or before
 * and after a change) to see whether a fix actually cut Upstash traffic.
 *
 *   node scripts/kv-usage-snapshot.mjs            # take a snapshot + print rates
 *   node scripts/kv-usage-snapshot.mjs --report   # print rates only
 *
 * REQUIREMENTS: .env.local with KV_REST_API_URL / KV_REST_API_TOKEN. Read-only.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRedisInfo, usageDeltas } from "../lib/kv-usage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "scripts/out/kv-usage.jsonl");

function loadEnv(file) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(".env.local");

function readLog() {
  try {
    return readFileSync(LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function snapshot() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN missing");
  const res = await fetch(`${url}/info`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Upstash INFO HTTP ${res.status}`);
  const { result } = await res.json();
  const snap = { ts: Date.now(), ...parseRedisInfo(result) };
  mkdirSync(path.dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify(snap) + "\n");
  return snap;
}

if (!process.argv.includes("--report")) {
  const snap = await snapshot();
  console.warn(`snapshot ${new Date(snap.ts).toISOString()} commands=${snap.commands}`);
}
const fmt = (n) => (n == null ? "reset" : n.toLocaleString("en-US"));
for (const d of usageDeltas(readLog())) {
  console.warn(
    `${new Date(d.from).toISOString().slice(0, 16)} → ${new Date(d.to).toISOString().slice(0, 16)}` +
      `  (${d.hours}h)  cmds/day=${fmt(d.commandsPerDay)}  reads/day=${fmt(d.readsPerDay)}` +
      `  writes/day=${fmt(d.writesPerDay)}  data=${((d.dataBytes || 0) / 1048576).toFixed(0)}MB`
  );
}
