import { searchEnabled, searchPages, SEARCH_MAX_PAGE_SIZE } from "../ls-search";

describe("searchEnabled", () => {
  it("defaults on, disables only with explicit 0", () => {
    expect(searchEnabled({})).toBe(true);
    expect(searchEnabled({ ENABLE_LS_SEARCH: "1" })).toBe(true);
    expect(searchEnabled({ ENABLE_LS_SEARCH: "0" })).toBe(false);
  });
});

describe("searchPages", () => {
  function pagedFetch(pages) {
    const calls = [];
    const fetchImpl = jest.fn(async (path) => {
      calls.push(path);
      return { data: pages.shift() ?? [] };
    });
    return { fetchImpl, calls };
  }

  it("offset-paginates until a short page and reports totals", async () => {
    const { fetchImpl, calls } = pagedFetch([
      Array.from({ length: 3 }, (_, i) => ({ id: i })),
      Array.from({ length: 3 }, (_, i) => ({ id: 3 + i })),
      [{ id: 6 }], // short page -> done
    ]);
    const seen = [];

    const result = await searchPages({
      lsFetch: fetchImpl,
      type: "products",
      pageSize: 3,
      onPage: (items) => seen.push(...items.map((i) => i.id)),
    });

    expect(result.done).toBe(true);
    expect(result.pages).toBe(3);
    expect(result.received).toBe(7);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(calls).toEqual([
      "2.0/search?type=products&page_size=3&offset=0",
      "2.0/search?type=products&page_size=3&offset=3",
      "2.0/search?type=products&page_size=3&offset=6",
    ]);
  });

  it("encodes scalar and array filter params", async () => {
    const { fetchImpl, calls } = pagedFetch([[]]);
    await searchPages({
      lsFetch: fetchImpl,
      type: "sales",
      pageSize: 1000,
      params: { date_from: "2026-01-01", date_to: "", tag_id: ["a", "b"] },
    });
    expect(calls[0]).toBe(
      "2.0/search?type=sales&page_size=1000&offset=0&date_from=2026-01-01&tag_id=a&tag_id=b"
    );
  });

  it("resumes from startOffset and stops at maxPages without finishing", async () => {
    const { fetchImpl, calls } = pagedFetch([
      Array.from({ length: 2 }, (_, i) => ({ id: i })),
      Array.from({ length: 2 }, (_, i) => ({ id: i })),
    ]);

    const result = await searchPages({
      lsFetch: fetchImpl,
      type: "products",
      pageSize: 2,
      startOffset: 10,
      maxPages: 1,
    });

    expect(result.done).toBe(false);
    expect(result.pages).toBe(1);
    expect(result.offset).toBe(12);
    expect(calls).toEqual(["2.0/search?type=products&page_size=2&offset=10"]);
  });

  it("caps page size at the /search maximum", async () => {
    const { fetchImpl, calls } = pagedFetch([[]]);
    await searchPages({ lsFetch: fetchImpl, type: "products", pageSize: 5000 });
    expect(calls[0]).toContain(`page_size=${SEARCH_MAX_PAGE_SIZE}`);
  });

  it("stops early (done=false) when less than minRemainingMs budget remains", async () => {
    let now = 0;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    // Each fetch returns a full page (would otherwise keep paging) and burns time.
    const fetchImpl = jest.fn(async () => {
      now += 41000;
      return { data: Array.from({ length: 2 }, (_, i) => ({ id: i })) };
    });

    const result = await searchPages({
      lsFetch: fetchImpl,
      type: "products",
      pageSize: 2,
      deadline: 60000,
      minRemainingMs: 20000,
    });

    // Only one page: after it, 60000-41000=19000 < 20000 so the loop stops.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.done).toBe(false);
    expect(result.offset).toBe(2);
    nowSpy.mockRestore();
  });

  it("forwards a retries cap to lsFetch when provided", async () => {
    const fetchImpl = jest.fn(async () => ({ data: [] }));
    await searchPages({ lsFetch: fetchImpl, type: "products", pageSize: 10, retries: 2 });
    expect(fetchImpl).toHaveBeenCalledWith("2.0/search?type=products&page_size=10&offset=0", 2);
  });

  it("calls lsFetch with a single arg when no retries cap is given", async () => {
    const fetchImpl = jest.fn(async () => ({ data: [] }));
    await searchPages({ lsFetch: fetchImpl, type: "products", pageSize: 10 });
    expect(fetchImpl).toHaveBeenCalledWith("2.0/search?type=products&page_size=10&offset=0");
    expect(fetchImpl.mock.calls[0]).toHaveLength(1);
  });
});
