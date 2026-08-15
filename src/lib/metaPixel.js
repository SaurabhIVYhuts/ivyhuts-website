// Meta (Facebook) Pixel — loaded once, PageView tracked on every route change.
// Pixel ID comes from REACT_APP_META_PIXEL_ID only; if it's unset the pixel
// simply never initializes (no fake/placeholder ID is ever used).
const PIXEL_ID = process.env.REACT_APP_META_PIXEL_ID;

let initialized = false;

// Exported so formConversionPixel.js (the separate form-submission/Lead
// pixel) can reuse this same idempotent loader instead of injecting a
// second copy of the fbq bootstrap script.
export function loadPixelScript() {
  if (window.fbq) return;

  /* eslint-disable */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */
}

export function initMetaPixel() {
  if (initialized || !PIXEL_ID || typeof window === "undefined") return;
  loadPixelScript();
  window.fbq("init", PIXEL_ID);
  initialized = true;
}

export function trackPageView() {
  if (!initialized || typeof window === "undefined" || !window.fbq) return;
  window.fbq("track", "PageView");
}
