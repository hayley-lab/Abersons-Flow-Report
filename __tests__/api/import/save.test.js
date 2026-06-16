// Regression test for pages/api/import/save.js.
//
// The datatail hard pull is a permanent historical baseline (RMH-era data that
// never reached LS). It must be written WITHOUT a TTL — a 30-day expiry used to
// silently drop those records and regress the report (4a). These tests lock in
// that override KV writes carry no `ex` option.
//
// Lives outside pages/ on purpose: anything under pages/ is compiled by Next as
// a route.

jest.mock("@vercel/kv", () => {
  const store = new Map();
  const pipelineSetCalls = [];
  const pipeline = {
    set: jest.fn((key, value, opts) => {
      pipelineSetCalls.push({ key, value, opts });
      return pipeline;
    }),
    exec: jest.fn(async () => []),
  };
  return {
    kv: {
      _store: store,
      _pipelineSetCalls: pipelineSetCalls,
      get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
      set: jest.fn(async (key, value) => {
        store.set(key, value);
      }),
      incr: jest.fn(async (key) => {
        const next = (Number(store.get(key)) || 0) + 1;
        store.set(key, next);
        return next;
      }),
      pipeline: jest.fn(() => pipeline),
    },
  };
});

jest.mock("iron-session", () => ({
  getIronSession: jest.fn(async () => ({ authed: true })),
}));

import { kv as mockKv } from "@vercel/kv";
import handler from "../../../pages/api/import/save";

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

beforeEach(() => {
  mockKv._store.clear();
  mockKv._pipelineSetCalls.length = 0;
  mockKv.set.mockClear();
});

it("writes override stores + vendorIndex without a TTL (ex) option", async () => {
  const req = {
    method: "POST",
    body: {
      season: "spring26",
      data: {
        stores: { "7": { name: "Alley" } },
        vendors: { "7__942": { vendorName: "Staud", products: [] } },
      },
    },
  };
  const res = makeRes();
  await handler(req, res);

  expect(res.body).toEqual({ ok: true, season: "spring26", vendorCount: 1 });

  // Every direct kv.set for an override key must be called with exactly
  // (key, value) — no third options arg carrying { ex } TTL.
  for (const call of mockKv.set.mock.calls) {
    expect(String(call[0])).toMatch(/^scan:override:spring26:/);
    expect(call).toHaveLength(2);
  }

  // The per-vendor pipeline writes must also omit the TTL option.
  expect(mockKv._pipelineSetCalls.length).toBe(1);
  for (const c of mockKv._pipelineSetCalls) {
    expect(c.key).toBe("scan:override:spring26:v:7__942");
    expect(c.opts).toBeUndefined();
  }
});

it("returns 400 when season or data is missing", async () => {
  const res = makeRes();
  await handler({ method: "POST", body: { season: "spring26" } }, res);
  expect(res.statusCode).toBe(400);
});
