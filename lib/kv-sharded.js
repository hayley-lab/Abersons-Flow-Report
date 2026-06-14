export const DEFAULT_KV_MAX_VALUE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_KV_SHARD_COUNT = 16;
export const SHARDED_OBJECT_VERSION = 1;

export function jsonSizeBytes(value) {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json == null ? "null" : json);
}

export function assertKvValueSize(key, value, maxBytes = DEFAULT_KV_MAX_VALUE_BYTES) {
  const size = jsonSizeBytes(value);
  if (size > maxBytes) {
    throw new Error(`KV value "${key}" is ${size} bytes, above the safe ${maxBytes} byte limit`);
  }
  return size;
}

export function shardForPid(pid, shardCount = DEFAULT_KV_SHARD_COUNT) {
  const str = String(pid == null ? "" : pid);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

export function shardedKvShardKey(baseKey, index) {
  return `${baseKey}:shard:${index}`;
}

export function isShardedKvObject(value) {
  return !!(
    value &&
    typeof value === "object" &&
    value.sharded === true &&
    value.version === SHARDED_OBJECT_VERSION
  );
}

function normalizeOptions(options) {
  const entries = Object.entries(options || {}).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function buildPidRecords(value, { pidFields, skuToPidFields, shardCount }) {
  const pidSet = new Set((value.seasonPids || []).map(String));
  for (const field of pidFields) {
    for (const pid of Object.keys(value[field] || {})) pidSet.add(String(pid));
  }
  const skuRecordsByField = {};
  for (const field of skuToPidFields) {
    skuRecordsByField[field] = {};
    for (const [sku, pid] of Object.entries(value[field] || {})) {
      if (pid == null) continue;
      const pidKey = String(pid);
      pidSet.add(pidKey);
      if (!skuRecordsByField[field][pidKey]) skuRecordsByField[field][pidKey] = {};
      skuRecordsByField[field][pidKey][sku] = pid;
    }
  }

  const shards = Array.from({ length: shardCount }, () => ({ records: {} }));
  for (const pid of pidSet) {
    const record = {};
    for (const field of pidFields) {
      if (value[field] && value[field][pid] !== undefined) record[field] = value[field][pid];
    }
    for (const field of skuToPidFields) {
      if (skuRecordsByField[field]?.[pid]) record[field] = skuRecordsByField[field][pid];
    }
    if (!Object.keys(record).length) continue;
    const index = shardForPid(pid, shardCount);
    shards[index].records[pid] = record;
  }
  return shards;
}

export async function setShardedObjectByPid(
  kv,
  baseKey,
  value,
  {
    ex,
    maxBytes = DEFAULT_KV_MAX_VALUE_BYTES,
    pidFields = [],
    shardCount = DEFAULT_KV_SHARD_COUNT,
    skuToPidFields = [],
  } = {}
) {
  const safeValue = value || {};
  const pidFieldSet = new Set([...pidFields, ...skuToPidFields]);
  const scalar = {};
  for (const [key, fieldValue] of Object.entries(safeValue)) {
    if (!pidFieldSet.has(key)) scalar[key] = fieldValue;
  }

  const marker = {
    sharded: true,
    version: SHARDED_OBJECT_VERSION,
    shardCount,
    ts: Date.now(),
    pidFields,
    skuToPidFields,
    scalar,
  };
  const shards = buildPidRecords(safeValue, { pidFields, skuToPidFields, shardCount });
  const options = normalizeOptions({ ex });

  assertKvValueSize(baseKey, marker, maxBytes);
  shards.forEach((shard, index) =>
    assertKvValueSize(shardedKvShardKey(baseKey, index), shard, maxBytes)
  );

  await Promise.all([
    kv.set(baseKey, marker, options),
    ...shards.map((shard, index) => kv.set(shardedKvShardKey(baseKey, index), shard, options)),
  ]);
  return marker;
}

// Incremental sibling of setShardedObjectByPid: rebuilds shard records from the
// FULL value (so each written shard is internally complete) but writes ONLY the
// marker plus the shards that hold a pid in `touchedPids`. Untouched shard keys
// keep their prior KV value, which still matches the cache because those pids
// did not change — getShardedObjectByPid merges them back transparently.
//
// This is the difference between O(total cache size) and O(delta) per save. The
// store-wide inventory cache has ~110k products across 16 shards; full-rewriting
// every shard after every inventory page blew the function timeout. With
// touched-shard writes a checkpoint only pays for the shards that actually
// changed since the last one.
//
// `touchedPids` semantics:
//   - undefined/null  → write every shard (same coverage as setShardedObjectByPid)
//   - a Set (possibly empty) → write only shards for those pids; an empty set
//     writes just the marker (cursor/version persistence with no shard churn).
// The marker is ALWAYS written because it carries the scalar fields (version
// cursor, ts) that readers and resume logic depend on.
export async function setShardedObjectByPidShards(
  kv,
  baseKey,
  value,
  {
    ex,
    maxBytes = DEFAULT_KV_MAX_VALUE_BYTES,
    pidFields = [],
    shardCount = DEFAULT_KV_SHARD_COUNT,
    skuToPidFields = [],
    touchedPids = null,
  } = {}
) {
  const safeValue = value || {};
  const pidFieldSet = new Set([...pidFields, ...skuToPidFields]);
  const scalar = {};
  for (const [key, fieldValue] of Object.entries(safeValue)) {
    if (!pidFieldSet.has(key)) scalar[key] = fieldValue;
  }

  const marker = {
    sharded: true,
    version: SHARDED_OBJECT_VERSION,
    shardCount,
    ts: Date.now(),
    pidFields,
    skuToPidFields,
    scalar,
  };
  const shards = buildPidRecords(safeValue, { pidFields, skuToPidFields, shardCount });
  const options = normalizeOptions({ ex });

  let shardIndices;
  if (touchedPids == null) {
    shardIndices = shards.map((_shard, index) => index);
  } else {
    const indices = new Set();
    for (const pid of touchedPids) indices.add(shardForPid(pid, shardCount));
    shardIndices = Array.from(indices);
  }

  assertKvValueSize(baseKey, marker, maxBytes);
  for (const index of shardIndices) {
    assertKvValueSize(shardedKvShardKey(baseKey, index), shards[index], maxBytes);
  }

  await Promise.all([
    kv.set(baseKey, marker, options),
    ...shardIndices.map((index) =>
      kv.set(shardedKvShardKey(baseKey, index), shards[index], options)
    ),
  ]);
  return marker;
}

export async function getShardedObjectByPid(kv, baseKey) {
  const marker = await kv.get(baseKey);
  if (!marker) return null;
  if (!isShardedKvObject(marker)) return marker;

  const shardCount = marker.shardCount || DEFAULT_KV_SHARD_COUNT;
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, index) => kv.get(shardedKvShardKey(baseKey, index)))
  );
  const result = { ...(marker.scalar || {}) };
  for (const field of marker.pidFields || []) {
    if (!result[field]) result[field] = {};
  }
  for (const field of marker.skuToPidFields || []) {
    if (!result[field]) result[field] = {};
  }

  for (const shard of shards) {
    for (const [pid, record] of Object.entries(shard?.records || {})) {
      for (const [field, fieldValue] of Object.entries(record || {})) {
        if ((marker.skuToPidFields || []).includes(field)) {
          result[field] = { ...(result[field] || {}), ...(fieldValue || {}) };
        } else {
          if (!result[field]) result[field] = {};
          result[field][pid] = fieldValue;
        }
      }
    }
  }
  return result;
}

export async function delShardedObject(kv, baseKey, { shardCount = DEFAULT_KV_SHARD_COUNT } = {}) {
  const marker = await kv.get(baseKey).catch(() => null);
  const effectiveShardCount = isShardedKvObject(marker)
    ? marker.shardCount || shardCount
    : shardCount;
  await Promise.all([
    kv.del(baseKey),
    ...Array.from({ length: effectiveShardCount }, (_, index) =>
      kv.del(shardedKvShardKey(baseKey, index))
    ),
  ]);
}
