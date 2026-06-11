import { SALES_PAGE_SIZE, fetchSalesPages } from "../ls-sales-pagination";

function makeSales(startVersion, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sale-${startVersion + index}`,
    version: startVersion + index,
  }));
}

describe("Lightspeed sales pagination", () => {
  it("requests page_size=500 by default", () => {
    expect(SALES_PAGE_SIZE).toBe(500);
  });

  it("paginates by cursor until an empty page, not by page fill", async () => {
    const paths = [];
    const processedCounts = [];
    const pages = [
      { version: { max: 500 }, data: makeSales(1, SALES_PAGE_SIZE) },
      { version: { max: 503 }, data: makeSales(501, 3) },
      { version: { max: 503 }, data: [] }, // empty trailing page -> done
    ];
    const lsFetch = jest.fn(async (path) => {
      paths.push(path);
      return pages[paths.length - 1];
    });

    const result = await fetchSalesPages({
      lsFetch,
      onPage: async (saleItems) => {
        processedCounts.push(saleItems.length);
      },
    });

    expect(result).toEqual({ cursor: 503, pages: 3, done: true });
    expect(processedCounts).toEqual([500, 3, 0]);
    expect(paths).toEqual([
      "2.0/sales?page_size=500",
      "2.0/sales?page_size=500&after=500",
      "2.0/sales?page_size=500&after=503",
    ]);
  });

  it("keeps paginating when the server caps a page below the requested size", async () => {
    // Regression for the undercount bug: requesting 500 but receiving 200 must
    // NOT terminate while the cursor is still advancing.
    const paths = [];
    const pages = [
      { version: { max: 200 }, data: makeSales(1, 200) },
      { version: { max: 350 }, data: makeSales(201, 150) },
      { version: { max: 350 }, data: [] },
    ];
    const lsFetch = jest.fn(async (path) => {
      paths.push(path);
      return pages[paths.length - 1];
    });

    const result = await fetchSalesPages({ lsFetch, onPage: async () => {} });

    expect(result.done).toBe(true);
    expect(result.pages).toBe(3);
    expect(result.cursor).toBe(350);
    expect(lsFetch).toHaveBeenCalledTimes(3);
  });

  it("stops if Lightspeed returns a non-advancing cursor", async () => {
    const lsFetch = jest.fn(async () => ({
      version: { max: 50 },
      data: makeSales(1, SALES_PAGE_SIZE),
    }));

    const result = await fetchSalesPages({
      lsFetch,
      initialCursor: 50,
      onPage: async () => {},
    });

    expect(result).toEqual({ cursor: 50, pages: 1, done: true });
    expect(lsFetch).toHaveBeenCalledTimes(1);
  });
});
