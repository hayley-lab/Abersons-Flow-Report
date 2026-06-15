jest.mock("@vercel/kv", () => {
  const store = new Map();
  return {
    kv: {
      _store: store,
      get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
      set: jest.fn(async (key, value) => {
        store.set(key, value);
      }),
    },
  };
});

import { kv as mockKv } from "@vercel/kv";
import {
  LS_HEALTH_KEY,
  getLsHealth,
  setLsHealth,
  markLsAuthError,
  markLsHealthy,
} from "../ls-auth";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ls-auth connection health", () => {
  beforeEach(() => {
    mockKv._store.clear();
    jest.clearAllMocks();
  });

  it("setLsHealth stores status + trimmed detail + ts", async () => {
    await setLsHealth("error", "x".repeat(500));
    const h = mockKv._store.get(LS_HEALTH_KEY);
    expect(h.status).toBe("error");
    expect(h.detail.length).toBe(200); // trimmed
    expect(typeof h.ts).toBe("number");
  });

  it("getLsHealth returns null when unset", async () => {
    await expect(getLsHealth()).resolves.toBeNull();
  });

  it("getLsHealth returns the stored health object", async () => {
    await setLsHealth("ok");
    const h = await getLsHealth();
    expect(h.status).toBe("ok");
    expect(h.detail).toBeNull();
  });

  it("markLsAuthError writes an error status (fire-and-forget)", async () => {
    markLsAuthError("LS 401 during scan");
    await flush();
    const h = await getLsHealth();
    expect(h.status).toBe("error");
    expect(h.detail).toBe("LS 401 during scan");
  });

  it("markLsHealthy clears a prior error", async () => {
    await setLsHealth("error", "token expired");
    markLsHealthy();
    await flush();
    const h = await getLsHealth();
    expect(h.status).toBe("ok");
  });

  it("setLsHealth swallows KV write errors", async () => {
    mockKv.set.mockRejectedValueOnce(new Error("KV down"));
    await expect(setLsHealth("ok")).resolves.toBeUndefined();
  });

  it("getLsHealth swallows KV read errors", async () => {
    mockKv.get.mockRejectedValueOnce(new Error("KV down"));
    await expect(getLsHealth()).resolves.toBeNull();
  });
});
