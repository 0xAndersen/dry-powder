/* Dry Powder service worker: an offline shell and fast repeat loads. Prices, positions and orders always come from
   the network (the chain and Kraken are cross-origin and never touched here). */
const VERSION = "__SW_VERSION__";
const SHELL = `dp-shell-${VERSION}`;
const ASSETS = `dp-assets-${VERSION}`;
const PAGES = ["simple/", "trade/", "markets/", "portfolio/", "activity/", "leaderboard/", "trader/", "house/", "agents/"];
const STATIC = ["manifest.webmanifest", "favicon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll([...PAGES, ...STATIC].map((p) => new URL(p, self.registration.scope).toString())))
      .catch(() => undefined),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("dp-") && k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  // Hashed build assets never change: cache first.
  if (url.pathname.includes("/_next/static/")) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Pages and config: network first (always the latest deployment), the cached shell when offline.
  if (request.mode === "navigate" || url.pathname.endsWith("/config.json")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && request.mode === "navigate") {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request, { ignoreSearch: true })) ?? (await caches.match(new URL("trade/", self.registration.scope).toString())) ?? Response.error()),
    );
    return;
  }

  if (STATIC.some((p) => url.pathname.endsWith(`/${p}`))) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
  }
});
