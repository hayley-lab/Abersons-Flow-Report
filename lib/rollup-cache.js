export const DEFAULT_ROLLUP_CACHE_TTL_MS = 45_000;
export const DEFAULT_ROLLUP_CACHE_MAX_ENTRIES = 8;

export function createRollupCache({
  ttlMs = DEFAULT_ROLLUP_CACHE_TTL_MS,
  maxEntries = DEFAULT_ROLLUP_CACHE_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function pruneExpired(currentTime = now()) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(key);
    }
  }

  function trimToMaxEntries() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  }

  return {
    get(key) {
      pruneExpired();
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    set(key, value) {
      if (maxEntries <= 0 || ttlMs <= 0) return value;
      pruneExpired();
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      trimToMaxEntries();
      return value;
    },

    clear() {
      entries.clear();
    },

    size() {
      pruneExpired();
      return entries.size;
    },
  };
}

export const reportRollupCache = createRollupCache();
