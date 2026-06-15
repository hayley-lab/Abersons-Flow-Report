const DEFAULT_RETRIES = 4;
const BASE_BACKOFF_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const LOW_REMAINING_PAUSE_MS = 1000;

// Sentinel for a SOFT abort: a 429/503 backoff would exceed the caller's
// deadline. Callers that have already checkpointed durable progress treat this
// as "incomplete, resume later" rather than a hard failure.
export const LS_DEADLINE_CODE = "LS_DEADLINE";

function deadlineError(path) {
  const err = new Error(`LS deadline exceeded during backoff for /${String(path).split("?")[0]}`);
  err.name = "LsDeadlineError";
  err.code = LS_DEADLINE_CODE;
  return err;
}

export function isLsDeadlineError(err) {
  return !!err && (err.code === LS_DEADLINE_CODE || err.name === "LsDeadlineError");
}

// Normalizes the second arg, which may be the legacy numeric `retries` or an
// options object `{ retries, deadline }`.
function normalizeFetchOptions(optsOrRetries) {
  if (optsOrRetries && typeof optsOrRetries === "object") {
    return {
      retries: optsOrRetries.retries ?? DEFAULT_RETRIES,
      deadline: optsOrRetries.deadline,
    };
  }
  return { retries: optsOrRetries ?? DEFAULT_RETRIES, deadline: undefined };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null;
}

function parseIntegerHeader(headers, name) {
  const value = getHeader(headers, name);
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseRetryAfterMs(value, now = Date.now()) {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - now);
}

export function rateLimitInfoFromHeaders(headers) {
  return {
    limit: parseIntegerHeader(headers, "x-ratelimit-limit"),
    remaining: parseIntegerHeader(headers, "x-ratelimit-remaining"),
    retryAfter: getHeader(headers, "retry-after"),
  };
}

export function estimateRegisterCount(limit) {
  if (!Number.isFinite(limit)) return null;
  const registers = (limit - 50) / 300;
  return registers > 0 ? registers : null;
}

function shouldPace(info, lowRemainingRatio) {
  if (!info.limit || info.remaining == null) return false;
  return info.remaining >= 0 && info.remaining <= Math.ceil(info.limit * lowRemainingRatio);
}

// Groups a request path into an endpoint family for call accounting, dropping
// the API version segment and collapsing nested resources (e.g.
// "2.0/consignments/123/products" -> "consignments/products").
export function endpointFamily(path) {
  const noQuery = String(path || "").split("?")[0];
  const parts = noQuery.split("/").filter(Boolean);
  let idx = 0;
  if (parts[0] && /^[0-9]/.test(parts[0])) idx = 1; // skip "2.0" / "2026-04"
  const fam = parts[idx] || "root";
  const sub = parts[idx + 2];
  if (sub && !/^[0-9a-f-]{6,}$/i.test(sub)) return `${fam}/${sub}`;
  return fam;
}

function retryWaitMs(response, attempt, { maxWaitMs }) {
  const retryAfter = parseRetryAfterMs(getHeader(response.headers, "retry-after"));
  if (response.status === 429 && retryAfter != null) {
    return Math.min(retryAfter, maxWaitMs);
  }
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), maxWaitMs);
}

export function makeLsFetch({
  base,
  headers,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  logger = console.warn,
  cache = "no-store",
  lowRemainingRatio = 0.1,
  lowRemainingPauseMs = LOW_REMAINING_PAUSE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  onRateLimitInfo,
  onAuthError,
} = {}) {
  if (!base) throw new Error("makeLsFetch requires a base URL");
  if (!fetchImpl) throw new Error("makeLsFetch requires fetch");

  let loggedLimit = false;
  // Live counter of actual HTTP requests issued, grouped by endpoint family.
  // Retries count as separate requests since they consume the rate-limit budget.
  const callStats = { total: 0, byFamily: {} };

  const lsFetch = async function lsFetch(path, optsOrRetries = DEFAULT_RETRIES) {
    const { retries, deadline } = normalizeFetchOptions(optsOrRetries);
    const family = endpointFamily(path);
    for (let attempt = 0; attempt <= retries; attempt++) {
      callStats.total++;
      callStats.byFamily[family] = (callStats.byFamily[family] || 0) + 1;
      const response = await fetchImpl(`${base}/${path}`, { headers, cache });
      const rateLimitInfo = rateLimitInfoFromHeaders(response.headers);

      if (rateLimitInfo.limit && !loggedLimit) {
        loggedLimit = true;
        const registers = estimateRegisterCount(rateLimitInfo.limit);
        const registerText = registers ? `, approx registers=${registers}` : "";
        logger?.(
          `[ls-fetch] Lightspeed rate limit: ${rateLimitInfo.limit} requests / 5 min${registerText}`
        );
      }
      if (rateLimitInfo.limit || rateLimitInfo.remaining != null) {
        onRateLimitInfo?.(rateLimitInfo);
      }

      if ((response.status === 429 || response.status === 503) && attempt < retries) {
        let waitMs = retryWaitMs(response, attempt, { maxWaitMs });
        if (deadline != null && Number.isFinite(deadline)) {
          const remaining = deadline - Date.now();
          // No budget left to back off: surface a soft deadline so the caller
          // checkpoints and resumes instead of being hard-killed at maxDuration.
          if (remaining <= 0) throw deadlineError(path);
          waitMs = Math.min(waitMs, remaining);
        }
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        // 401/403 = bad/expired token (not a rate limit). Surface it so callers
        // can flag LS connection health in the UI instead of only failing silently.
        if (response.status === 401 || response.status === 403) {
          onAuthError?.({ status: response.status, body: text.slice(0, 120) });
        }
        throw new Error(`LS ${response.status} /${path.split("?")[0]}: ${text.slice(0, 120)}`);
      }

      const json = await response.json();
      if (shouldPace(rateLimitInfo, lowRemainingRatio)) {
        await sleep(lowRemainingPauseMs);
      }
      return json;
    }
  };

  // Live request accounting for the current lsFetch instance (one per step call).
  lsFetch.callStats = callStats;
  return lsFetch;
}
