// 2.0/sales accepts page_size up to 500 (measured). Termination is cursor-based
// (below), so a server that caps a page below this still paginates correctly.
export const SALES_PAGE_SIZE = 500;

export function getCursor(data, items) {
  const vfr = data.version && typeof data.version === "object" ? data.version.max : null;
  const vfi = items.reduce((mx, item) => Math.max(mx, item.version || 0), 0);
  return (vfr !== null ? vfr : vfi) || null;
}

export async function fetchSalesPages({
  lsFetch,
  deadline = Infinity,
  initialCursor = null,
  dateFrom = "",
  pageSize = SALES_PAGE_SIZE,
  onPage,
}) {
  if (!lsFetch) throw new Error("fetchSalesPages requires lsFetch");

  let cursor = initialCursor || null;
  let pages = 0;
  let done = false;

  while (Date.now() < deadline) {
    const dateParam = dateFrom ? `&date_from=${encodeURIComponent(dateFrom)}` : "";
    const path = `2.0/sales?page_size=${pageSize}` + dateParam + (cursor ? `&after=${cursor}` : "");
    const data = await lsFetch(path);
    const saleItems = data.data || [];
    pages++;

    if (onPage) await onPage(saleItems, { data, cursor, pages });

    const nextCursor = getCursor(data, saleItems);
    // Terminate on the version cursor, never on page fill. Requesting
    // page_size=500 but receiving a server-capped page (e.g. 200) must NOT be
    // read as "last page" — that was the old undercount bug. Stop only when a
    // page is empty or the cursor stops advancing (costs one trailing empty
    // fetch at the end, which is negligible and keeps counts correct).
    if (saleItems.length === 0 || !nextCursor || nextCursor === cursor) {
      done = true;
      break;
    }
    cursor = nextCursor;
  }

  return { cursor, pages, done };
}
