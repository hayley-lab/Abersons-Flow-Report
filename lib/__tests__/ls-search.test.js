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
});
