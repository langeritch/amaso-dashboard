import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable image optimization until it's needed — keeps the custom server simpler
  images: { unoptimized: true },
  // Allow the dashboard to be accessed via the Cloudflare Tunnel hostname,
  // plus the loopback hosts — the in-app browser-stream (headless Chromium
  // driven by Playwright) navigates to http://127.0.0.1:3737, and without
  // these Next blocks its HMR websocket as cross-origin.
  allowedDevOrigins: ["dashboard.amaso.nl", "127.0.0.1", "localhost"],
  // The Next.js dev indicator (the floating "N" bubble) sits on top of
  // the terminal on mobile and eats ~40px of screen real estate.
  // Nothing the dashboard itself surfaces relies on it.
  devIndicators: false,
  // Pin the Turbopack workspace root. Without this, Turbopack walks up from
  // `app/` looking for `next/package.json` and sometimes guesses wrong when
  // the custom server (tsx) changes its resolution root mid-boot, logging
  // "Next.js inferred your workspace root, but it may not be correct".
  turbopack: { root: path.resolve(".") },
};

export default nextConfig;
