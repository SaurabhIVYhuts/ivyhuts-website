// A simple global counter of client-side page views (route changes),
// persisted in localStorage so it survives across the whole site — not
// just whichever page happens to be mounted. Used to re-arm the homepage
// lead popup after the visitor has explored a few more pages, instead of
// a fixed time-based cooldown.
const PAGE_VIEW_COUNT_KEY = "ivyhuts_page_view_count";

export function bumpPageViewCount() {
  const next = getPageViewCount() + 1;
  localStorage.setItem(PAGE_VIEW_COUNT_KEY, String(next));
  return next;
}

export function getPageViewCount() {
  return Number(localStorage.getItem(PAGE_VIEW_COUNT_KEY) || 0);
}
