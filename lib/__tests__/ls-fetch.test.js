import { makeLsFetch, parseRetryAfterMs } from "../ls-fetch";

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
});
