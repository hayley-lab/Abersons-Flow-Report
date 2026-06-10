import { SALES_PAGE_SIZE, fetchSalesPages } from "../ls-sales-pagination";

function makeSales(startVersion, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `sale-${startVersion + index}`,
    version: startVersion + index,
  }));
}

describe("Lightspeed sales pagination", () => {
  it("processes multiple full 200-row pages before stopping on a short page", async () => {
    const paths = [];
    const processedCounts = [];
    const pages = [
      { version: { max: 200 }, data: makeSales(1, SALES_PAGE_SIZE) },
      { version: { max: 400 }, data: makeSales(201, SALES_PAGE_SIZE) },
      { version: { max: 403 }, data: makeSales(401, 3) },
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

    expect(result).toEqual({ cursor: 400, pages: 3, done: true });
    expect(processedCounts).toEqual([200, 200, 3]);
    expect(paths).toEqual([
      "2.0/sales?page_size=200",
      "2.0/sales?page_size=200&after=200",
      "2.0/sales?page_size=200&after=400",
    ]);
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
