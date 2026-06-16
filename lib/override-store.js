export function parseKvJson(value) {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function loadOverride(kv, season) {
  const [storesRaw, indexRaw] = await Promise.all([
    kv.get(`scan:override:${season}:stores`),
    kv.get(`scan:override:${season}:vendorIndex`),
  ]);
  if (!indexRaw) return null;

  const vendorIndex = parseKvJson(indexRaw);
  const stores = parseKvJson(storesRaw) || {};
  if (!Array.isArray(vendorIndex)) return null;

  const vendorRaws = await Promise.all(
    vendorIndex.map((key) => kv.get(`scan:override:${season}:v:${key}`))
  );
  const vendors = {};
  vendorIndex.forEach((key, index) => {
    vendors[key] = parseKvJson(vendorRaws[index]);
  });

  return { stores, vendors, vendorIndex };
}
