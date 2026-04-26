// Amaso Dashboard service worker.
//
// Caching strategy:
//   - Navigations (HTML) use network-first with a cached fallback, so users
//     who are offline still see the last shell, but online users always get
//     fresh HTML — no stale deployments.
//   - Static assets under /_next/static/* and /icon*, /manifest* use
//     stale-while-revalidate for instant loads with background refresh.
//   - /api/*, websockets, HMR, and anything with _rsc are never intercepted —
//     real-time data beats stale data.
//
// Auto-update behaviour:
//   - `skipWaiting()` + `clients.claim()` so new worker versions activate
//     immediately without prompting the user.
//   - Every new deploy bumps CACHE_VERSION (baked in by the build) so the
//     activate step purges older buckets.
//   - Clients listening for the `controllerchange` event trigger a soft
//     reload so the new assets actually get fetched — hot-reload semantics
//     without a visible prompt.
const CACHE_VERSION = "v4";
const RUNTIME_CACHE = `amaso-runtime-${CACHE_VERSION}`;
const SHELL_CACHE = `amaso-shell-${CACHE_VERSION}`;

// On localhost the SW must not intercept anything. Turbopack rewrites
// /_next/static/* chunks between dev sessions but filenames can repeat, so a
// stale-while-revalidate hit serves a chunk whose module factory no longer
// matches the current HMR runtime ("module factory is not available"). Pass
// straight to network in dev regardless of whether the worker got torn down.
const IS_DEV_HOST = /^(localhost|127\.|\[?::1)/i.test(self.location.hostname);
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Manual trigger from the page in case it wants to force-activate a waiting
// worker (e.g. after the user clicks "check for updates").
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icon") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/apple-touch-icon.png"
  );
}

self.addEventListener("fetch", (event) => {
  if (IS_DEV_HOST) return;
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept realtime / API / HMR / RSC — stale data here is worse
  // than none, and HMR breaks if we touch it.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/webpack-hmr") ||
    url.pathname.startsWith("/_next/data/") ||
    url.pathname.startsWith("/ws") ||
    url.search.includes("_rsc")
  ) {
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  }
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response("", { status: 504 });
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const copy = res.clone();
      caches
        .open(RUNTIME_CACHE)
        .then((c) => c.put(req, copy))
        .catch(() => {});
    }
    return res;
  } catch {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const shell = await caches.open(SHELL_CACHE);
    const fallback = await shell.match("/");
    if (fallback) return fallback;
    return new Response("Offline", { status: 503, statusText: "offline" });
  }
}

// --- Web Push --------------------------------------------------------------

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Amaso", body: event.data.text() };
  }
  const title = payload.title || "Amaso";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag,
    // Replace older notifications sharing the same tag (e.g. per-channel)
    // so a busy channel doesn't pile up dozens of shade entries.
    renotify: Boolean(payload.tag),
    data: { url: payload.url || "/", ...(payload.data || {}) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // If a dashboard window is already open, focus it and navigate.
        for (const client of clientList) {
          if (client.url.includes(self.location.origin)) {
            client.focus();
            if ("navigate" in client) {
              return client.navigate(target).catch(() => {});
            }
            // Fallback: postMessage so the client can route client-side
            // without a full reload.
            client.postMessage({ type: "amaso:navigate", url: target });
            return;
          }
        }
        // Otherwise open a fresh window at the target path.
        return self.clients.openWindow(target);
      }),
  );
});
