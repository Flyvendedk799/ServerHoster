/**
 * Offline shell for the companion app.
 *
 * The one rule that matters here: **only same-origin app assets are ever
 * cached**. Everything this app fetches from a paired machine carries a device
 * token and describes live infrastructure state; caching any of it would leave
 * credentials and stale status in a store that outlives the tab. Cross-origin
 * requests are passed straight through, untouched.
 *
 * The shell itself is cached stale-while-revalidate so opening the app in a
 * tunnel or a lift shows the UI (and its "can't reach this server" banner)
 * instead of the browser's offline dinosaur.
 */

const CACHE = "serverhoster-companion-v1";

self.addEventListener("install", (event) => {
  // Take over as soon as the new bundle is ready rather than waiting for every
  // tab to close — a PWA on a phone is often never "closed".
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // A paired machine is always a different origin (or, when the app is served
  // by the control plane itself, a path we deliberately don't cache either).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/companion/") || url.pathname.startsWith("/services/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        // Refresh in the background; the user gets the cached copy instantly.
        event.waitUntil(network);
        return cached;
      }

      const fresh = await network;
      if (fresh) return fresh;

      // A cold navigation with no network: fall back to the cached shell so the
      // SPA can boot and explain itself.
      if (request.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      return new Response("Offline", { status: 503, statusText: "Offline" });
    })()
  );
});
