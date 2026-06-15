import { endpointFamily, isLsDeadlineError, makeLsFetch, parseRetryAfterMs } from "../ls-fetch";

function createResponse({ status = 200, body = {}, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? headers[name] ?? null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

describe("ls fetch helper", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("parses RFC1123 Retry-After dates", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const retryAt = new Date(now + 5000).toUTCString();

    expect(parseRetryAfterMs(retryAt, now)).toBe(5000);
  });

  it("honors Retry-After on 429 before retrying", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    jest.spyOn(Date, "now").mockReturnValue(now);
    const retryAt = new Date(now + 5000).toUTCString();
    const sleep = jest.fn(async () => {});
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        createResponse({
          status: 429,
          body: "too many",
          headers: { "retry-after": retryAt },
        })
      )
      .mockResolvedValueOnce(createResponse({ body: { ok: true } }));

    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      headers: { Authorization: "Bearer token" },
      fetchImpl,
      sleep,
      logger: null,
    });

    await expect(lsFetch("2.0/products")).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("paces when rate-limit remaining is low", async () => {
    const sleep = jest.fn(async () => {});
    const fetchImpl = jest.fn().mockResolvedValue(
      createResponse({
        body: { ok: true },
        headers: {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "5",
        },
      })
    );

    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      fetchImpl,
      sleep,
      logger: null,
    });

    await expect(lsFetch("2.0/sales")).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("preserves the Lightspeed error message format", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({ status: 500, body: "broken" }));
    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      fetchImpl,
      logger: null,
    });

    await expect(lsFetch("2.0/sales?page_size=200", 0)).rejects.toThrow(
      "LS 500 /2.0/sales: broken"
    );
  });

  it("calls onAuthError for 401/403 (not for other errors) and still throws", async () => {
    const onAuthError = jest.fn();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ status: 401, body: "expired token" }))
      .mockResolvedValueOnce(createResponse({ status: 403, body: "forbidden" }))
      .mockResolvedValueOnce(createResponse({ status: 500, body: "server error" }));
    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      fetchImpl,
      logger: null,
      onAuthError,
    });

    await expect(lsFetch("2.0/products", 0)).rejects.toThrow("LS 401");
    await expect(lsFetch("2.0/products", 0)).rejects.toThrow("LS 403");
    await expect(lsFetch("2.0/products", 0)).rejects.toThrow("LS 500");

    expect(onAuthError).toHaveBeenCalledTimes(2);
    expect(onAuthError).toHaveBeenNthCalledWith(1, { status: 401, body: "expired token" });
    expect(onAuthError).toHaveBeenNthCalledWith(2, { status: 403, body: "forbidden" });
  });

  it("caps the backoff sleep to the remaining deadline budget", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    const sleep = jest.fn(async () => {});
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ status: 503, body: "down" }))
      .mockResolvedValueOnce(createResponse({ body: { ok: true } }));

    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      fetchImpl,
      sleep,
      logger: null,
    });

    // Default backoff for attempt 0 is 2000ms, but only 500ms of budget remains.
    await expect(lsFetch("2.0/sales", { retries: 4, deadline: 1500 })).resolves.toEqual({
      ok: true,
    });
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("throws a typed soft deadline error when no backoff budget remains", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2000);
    const sleep = jest.fn(async () => {});
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({ status: 503, body: "down" }));

    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      fetchImpl,
      sleep,
      logger: null,
    });

    await expect(lsFetch("2.0/sales", { retries: 4, deadline: 1999 })).rejects.toMatchObject({
      code: "LS_DEADLINE",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recognizes the soft deadline error via isLsDeadlineError", async () => {
    jest.spyOn(Date, "now").mockReturnValue(2000);
    const fetchImpl = jest.fn().mockResolvedValue(createResponse({ status: 429, body: "slow" }));
    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      fetchImpl,
      sleep: jest.fn(async () => {}),
      logger: null,
    });

    const err = await lsFetch("2.0/inventory", { deadline: 1000 }).catch((e) => e);
    expect(isLsDeadlineError(err)).toBe(true);
  });

  it("counts requests per endpoint family (retries included)", async () => {
    const sleep = jest.fn(async () => {});
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(createResponse({ status: 503, body: "down" }))
      .mockResolvedValue(createResponse({ body: { ok: true } }));

    const lsFetch = makeLsFetch({
      base: "https://example.test/api",
      fetchImpl,
      sleep,
      logger: null,
    });

    await lsFetch("2.0/sales?page_size=200"); // 503 then 200 → 2 requests
    await lsFetch("2.0/consignments/abc123def456/products");
    await lsFetch("2.0/products/99/inventory");

    expect(lsFetch.callStats.total).toBe(4);
    expect(lsFetch.callStats.byFamily).toEqual({
      sales: 2,
      "consignments/products": 1,
      "products/inventory": 1,
    });
  });
});

describe("endpointFamily", () => {
  it("drops the version segment and returns the resource", () => {
    expect(endpointFamily("2.0/products?page_size=200")).toBe("products");
    expect(endpointFamily("2026-04/search?type=products")).toBe("search");
    expect(endpointFamily("2.0/product_types")).toBe("product_types");
  });

  it("collapses nested resources but ignores id segments", () => {
    expect(endpointFamily("2.0/consignments/0a1b2c3d4e/products")).toBe("consignments/products");
    expect(endpointFamily("2.0/products/123/inventory")).toBe("products/inventory");
    expect(endpointFamily("2.0/products/123")).toBe("products");
  });
});
