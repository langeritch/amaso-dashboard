import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import Script from "next/script";
import ShareIngress from "../components/ShareIngress";
import SparProvider from "../components/SparProvider";
import { SparFooterProvider } from "../components/SparFooterContext";
import SparMiniOverlay from "../components/SparMiniOverlay";
import SparMiniPlayer from "../components/SparMiniPlayer";
import SplashScreen from "../components/SplashScreen";
import UserTracker from "../components/UserTracker";
import { getCurrentUser } from "../lib/auth";
import { isSuperUser, readHeartbeat } from "../lib/heartbeat";
import "./globals.css";

export const THEME_COOKIE = "amaso:theme";

export const metadata: Metadata = {
  title: "Amaso Dashboard",
  description: "Live project dashboard",
  applicationName: "Amaso",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Amaso",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

// Only the bits Next.js can express typed stay here. The full viewport
// directive lives in a raw <meta> below because `interactive-widget`
// isn't in Next's Viewport type yet and we need it to make iOS shrink
// the layout when the on-screen keyboard appears (otherwise the prompt
// stays behind the keyboard).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0c" },
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
  ],
};

// Theme is server-side: we read the theme cookie here and apply
// `className="light"` to <html> directly. No client bootstrap script
// is needed (and React 19 warns on any <script> rendered in the React
// tree, regardless of `src` or inline content). Toggle components
// write both the cookie and localStorage when the user switches.

// Register the service worker so the app installs cleanly and cold-launches
// with its own chrome. Registration is best-effort; failures are silent.
//
// Dev mode: the SW is fully disabled AND any previously-installed worker is
// unregistered with its caches purged. Without this, any stale HTML the old
// worker cached gets served to the client while the fresh _next/static
// chunks come from the network — classic hydration mismatch. The dev flag
// is baked in by Next at build time via NODE_ENV.
//
// Prod: `skipWaiting()` + a one-shot reload on `controllerchange` means a
// new deploy takes over silently without update prompts.
const swEnabled = process.env.NODE_ENV === "production";
const swBootstrap = swEnabled
  ? `(function(){
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').then(function(reg){
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', function(){
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function(){
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(function(){});

    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function(){
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
})();`
  : `(function(){
  if (!('serviceWorker' in navigator)) return;
  // Dev: tear down any previously-installed worker and nuke its caches so
  // stale HTML doesn't shadow fresh HMR chunks (causes hydration errors).
  navigator.serviceWorker.getRegistrations().then(function(regs){
    var hadOne = regs.length > 0;
    return Promise.all(regs.map(function(r){ return r.unregister(); })).then(function(){
      if (self.caches && self.caches.keys) {
        return caches.keys().then(function(keys){
          return Promise.all(keys.map(function(k){ return caches.delete(k); }));
        }).then(function(){
          // One reload after unregistering so the next request bypasses the
          // now-dead worker entirely. Gate on a sessionStorage flag so we
          // don't reload-loop.
          if (hadOne && !sessionStorage.getItem('amaso:sw-cleared')) {
            sessionStorage.setItem('amaso:sw-cleared', '1');
            location.reload();
          }
        });
      }
    });
  }).catch(function(){});
})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Spar lives at the layout level so its call state, audio element, and
  // recognition session survive navigation between /spar and project
  // pages. The mini circle (rendered inside the provider) only appears
  // off-/spar while a call is active. /login and /setup have no user
  // yet — fall through without mounting Spar. Clients also skip Spar:
  // the sparring partner is an internal tool, not a client-facing one.
  const user = await getCurrentUser();
  const sparBoot =
    user && user.role !== "client"
      ? {
          currentUser: { id: user.id, name: user.name, email: user.email },
          canManageOthers: isSuperUser(user),
          initialHeartbeat: readHeartbeat(user.id),
        }
      : null;

  const cookieStore = await cookies();
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const htmlClassName = themeCookie === "light" ? "light" : undefined;

  return (
    <html lang="en" className={htmlClassName} suppressHydrationWarning>
      <head>
        {/* interactive-widget=resizes-content is the key bit: iOS only
         * shrinks the *visual* viewport when the keyboard opens by
         * default, so the prompt ends up hidden behind it. With this
         * directive the layout viewport also shrinks and `100dvh`
         * follows, so the terminal fits above the keyboard. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content"
        />
      </head>
      <body className="min-h-[100dvh]">
        {/* afterInteractive — React 19 refuses a <script> in the render
         * tree, and Next's beforeInteractive strategy injects one. The
         * dev-mode SW teardown still fires early enough because the
         * sessionStorage-guarded reload recovers cleanly on next load. */}
        <Script id="amaso-sw-bootstrap" strategy="afterInteractive">
          {swBootstrap}
        </Script>
        <ShareIngress />
        {sparBoot ? (
          <SparProvider {...sparBoot}>
            <SparFooterProvider>
              <UserTracker />
              {children}
              <SparMiniOverlay />
              <SparMiniPlayer />
            </SparFooterProvider>
          </SparProvider>
        ) : (
          children
        )}
        <SplashScreen />
      </body>
    </html>
  );
}
