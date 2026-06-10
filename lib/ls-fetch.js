const DEFAULT_RETRIES = 4;
const BASE_BACKOFF_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const LOW_REMAINING_PAUSE_MS = 1000;

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
} = {}) {
  if (!base) throw new Error("makeLsFetch requires a base URL");
  if (!fetchImpl) throw new Error("makeLsFetch requires fetch");

  let loggedLimit = false;

  return async function lsFetch(path, retries = DEFAULT_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
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
        await sleep(retryWaitMs(response, attempt, { maxWaitMs }));
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`LS ${response.status} /${path.split("?")[0]}: ${text.slice(0, 120)}`);
      }

      const json = await response.json();
      if (shouldPace(rateLimitInfo, lowRemainingRatio)) {
        await sleep(lowRemainingPauseMs);
      }
      return json;
    }
  };
}
