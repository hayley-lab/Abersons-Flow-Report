// Helper for the Lightspeed /search endpoint (2.0/search).
//
// Unlike the collection endpoints (max page_size 200, version-cursor `after`
// pagination), /search supports page_size up to 1000 and uses offset-based
// pagination. That makes it ~5x cheaper per record for bulk pulls — the whole
// product catalog or a season's sales backfill in a fraction of the calls.
//
// Pagination contract (per LS docs): keep advancing `offset` by the page size
// until a page returns fewer than page_size rows. Do not rely on the page size
// to decide whether to stop — always check the returned count.

export const SEARCH_PAGE_SIZE = 1000;
export const SEARCH_MAX_PAGE_SIZE = 1000;

// True unless explicitly disabled. Lets the migration ship dark by setting
// ENABLE_LS_SEARCH=0, then be turned on without a code change.
export function searchEnabled(env = process.env) {
  return env.ENABLE_LS_SEARCH !== "0";
}

function buildSearchPath(type, params, pageSize, offset) {
  const qs = new URLSearchParams();
  qs.set("type", type);
  qs.set("page_size", String(pageSize));
  qs.set("offset", String(offset));
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, String(v));
    } else {
      qs.append(key, String(value));
    }
  }
  return `2.0/search?${qs.toString()}`;
}

// Offset-paginate /search, invoking onPage(items, meta) for each page. Resumable
// across step calls via startOffset / the returned offset. Stops on a short
// page (done=true), the deadline, or maxPages (done=false → resume next step).
//
// minRemainingMs guards against starting a page that cannot finish before the
// deadline (and the surrounding function's hard maxDuration): when less than
// that much budget remains, stop early and report done=false so the caller can
// persist progress and resume. retries is forwarded to lsFetch so bulk pagers
// can cap retry backoff (a long backoff on a single page can otherwise blow the
// function budget mid-page).
export async function searchPages({
  lsFetch,
  type,
  params = {},
  pageSize = SEARCH_PAGE_SIZE,
  startOffset = 0,
  deadline = Infinity,
  maxPages = Infinity,
  minRemainingMs = 0,
  retries,
  onPage,
}) {
  if (!lsFetch) throw new Error("searchPages requires lsFetch");
  if (!type) throw new Error("searchPages requires a type");
  const size = Math.min(pageSize, SEARCH_MAX_PAGE_SIZE);

  let offset = startOffset;
  let pages = 0;
  let received = 0;
  let done = false;

  while (deadline - Date.now() > minRemainingMs && pages < maxPages) {
    const data =
      retries == null
        ? await lsFetch(buildSearchPath(type, params, size, offset))
        : await lsFetch(buildSearchPath(type, params, size, offset), retries);
    const items = data?.data || [];
    pages++;
    received += items.length;

    if (onPage) await onPage(items, { offset, page: pages - 1, data });

    if (items.length < size) {
      done = true;
      break;
    }
    offset += size;
  }

  return { offset, pages, received, done };
}
