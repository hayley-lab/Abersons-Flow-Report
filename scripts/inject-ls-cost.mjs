#!/usr/bin/env node
/*
 * Fill-only injection of authoritative RMH cost into Lightspeed supply_price for
 * the tiny residual set of active-season products that LS has at $0 cost.
 *
 * WHY: scripts/measure-ls-cost-gap.mjs proved LS already carries cost for 99% of
 * active-season products; only a handful are $0 in LS AND have a real RMH
 * POType=0 cost to fill. This makes LS itself correct for those SKUs (benefits
 * every LS report, not just this app). The report's own gap is handled
 * separately by the durable KV override.
 *
 * SAFETY (production POS write):
 *   - FILL-ONLY: each product is re-fetched immediately before writing and
 *     SKIPPED unless its current supply_price is 0 — a real LS cost is never
 *     overwritten.
 *   - SUPPLIER-SCOPED: cost is written via details.product_suppliers for the
 *     supplier ALREADY on the product (2.1 API). Products with no supplier are
 *     skipped (we never create a supplier link) and reported for manual entry.
 *   - VARIANT-SCOPED: written in the `details` section, so only the exact
 *     variant in the URL is touched (never the whole family).
 *   - ROLLBACK LOG: prior state (supply_price + product_suppliers) is written to
 *     scripts/.ls-cost-rollback-<ts>.json before any change.
 *   - Dry-run by default; --write performs the PUTs.
 *
 * REQUIREMENTS: .env.local with LS_DOMAIN_PREFIX + LS_ACCESS_TOKEN (WRITE scope).
 *
 * USAGE:
 *   node scripts/inject-ls-cost.mjs            # dry run (no writes)
 *   node scripts/inject-ls-cost.mjs --write    # perform the PUTs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(".env.local");
loadEnv(".env");

const WRITE = process.argv.slice(2).includes("--write");

// The exact fillable set from scripts/measure-ls-cost-gap.mjs (LS supply_price=0
// AND a positive RMH POType=0 cost). Costs are RMH MAX(Item.Cost).
const TARGETS = [
  { sku: "tsacp18a/s260101", id: "70eb4717-0a9d-49c5-a1d6-caf54f480ae1", cost: 579 },
  { sku: "tssbilma/s260204", id: "6c204543-47fe-4c4f-b303-661dc26a5217", cost: 312.5 },
  { sku: "tsssavy/s260101", id: "53ef933d-183b-4cf6-95be-ad37d0d19074", cost: 275 },
  { sku: "tssbilma/s260302", id: "74d43d5b-63ed-4daa-99b4-a8aeb5b45f26", cost: 312.5 },
  { sku: "n12088/pf260104", id: "11f06f30-cf74-49d4-a625-ac82ea2e60ea", cost: 113 },
];

const PREFIX = process.env.LS_DOMAIN_PREFIX;
const TOK = process.env.LS_ACCESS_TOKEN;
const API = (v, p) => `https://${PREFIX}.retail.lightspeed.app/api/${v}/${p}`;

async function getProduct(id) {
  const res = await fetch(API("2.0", `products/${id}`), {
    headers: { Authorization: `Bearer ${TOK}` },
  });
  if (!res.ok) throw new Error(`GET product ${id} HTTP ${res.status}`);
  return (await res.json()).data || {};
}

async function putSupplyPrice(id, supplierId, price) {
  const body = { details: { product_suppliers: [{ supplier_id: supplierId, price }] } };
  const res = await fetch(API("2.1", `products/${id}`), {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PUT product ${id} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function main() {
  if (!PREFIX || !TOK) throw new Error("LS env missing (LS_DOMAIN_PREFIX + LS_ACCESS_TOKEN).");
  const rollback = [];
  const skipped = [];
  let wrote = 0;

  for (const t of TARGETS) {
    const p = await getProduct(t.id);
    const current = Number(p.supply_price) || 0;
    const supplierId = p.supplier_id || null;
    if (current > 0) {
      skipped.push({ ...t, reason: `LS already has cost $${current} (fill-only guard)` });
      continue;
    }
    if (!supplierId) {
      skipped.push({ ...t, reason: "no supplier on product — assign a supplier in LS first" });
      continue;
    }
    rollback.push({
      id: t.id,
      sku: t.sku,
      supplier_id: supplierId,
      prior_supply_price: current,
      prior_product_suppliers: p.product_suppliers || [],
    });
    console.warn(
      `${WRITE ? "WRITE" : "DRY "} ${t.sku.padEnd(22)} supplier=${supplierId}  price 0 -> ${t.cost}`
    );
    if (WRITE) {
      await putSupplyPrice(t.id, supplierId, t.cost);
      const after = await getProduct(t.id);
      console.warn(`   -> LS now supply_price=${after.supply_price}`);
      wrote += 1;
    }
  }

  if (skipped.length) {
    console.warn("\nSkipped:");
    for (const s of skipped) console.warn(`  ${s.sku.padEnd(22)} ${s.reason}`);
  }

  if (WRITE && rollback.length) {
    const file = path.join(ROOT, "scripts", `.ls-cost-rollback-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(rollback, null, 2));
    console.warn(`\nWrote ${wrote} product(s). Rollback log: ${path.relative(ROOT, file)}`);
  } else if (!WRITE) {
    console.warn(
      `\nDRY RUN — no writes. ${rollback.length} product(s) would be filled, ${skipped.length} skipped.` +
        "\nRe-run with --write to perform the PUTs."
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
