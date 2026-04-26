import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import type { CompanionReleaseInfo } from "@/lib/companion-release";

export const runtime = "nodejs";
// Cached server-side (see CACHE_TTL_MS) so we don't hit GitHub's
// unauthenticated rate limit (60 req/h per IP) on every Settings →
// Install pageview. `force-dynamic` would defeat that — the cache
// lives in module memory, but Next would still re-import it.
export const revalidate = 600; // 10 min, matches CACHE_TTL_MS

// Asset names produced by .github/workflows/build-companion.yml
// (see electron/package.json → build.mac.artifactName). The DMG is
// the user-facing download; the ZIP exists for electron-updater and
// is hidden from the UI.
const REPO_OWNER = "langeritch";
const REPO_NAME = "amaso-dashboard";
const TAG_PREFIX = "companion-v";
const ARM64_ASSET = "amaso-companion-arm64.dmg";
const X64_ASSET = "amaso-companion-x64.dmg";

const CACHE_TTL_MS = 10 * 60 * 1000;

interface GithubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

let cached: { at: number; info: CompanionReleaseInfo | null } | null = null;

/**
 * Fetch the latest published `companion-v*` release. Walks /releases
 * (rather than /releases/latest) because /releases/latest ignores the
 * tag prefix — a future non-companion tag on the same repo would
 * mask the companion DMG. Picks the most recent published, non-draft,
 * non-prerelease release whose tag starts with `companion-v`.
 */
async function fetchLatestRelease(): Promise<CompanionReleaseInfo | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "amaso-dashboard",
  };
  // Optional: pass a PAT if the deployment provides one. Lifts the
  // unauthenticated 60 req/h limit to 5000 req/h, which we're nowhere
  // near, but it's free insurance against a noisy neighbour on the
  // same egress IP.
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=20`,
    { headers, cache: "no-store" },
  );
  if (!res.ok) {
    // 404 = repo private / not found, 403 = rate limited. Either way,
    // surface "no release" rather than crashing the install page.
    return null;
  }
  const releases = (await res.json()) as GithubRelease[];
  if (!Array.isArray(releases)) return null;

  const candidate = releases
    .filter(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        typeof r.tag_name === "string" &&
        r.tag_name.startsWith(TAG_PREFIX),
    )
    // GitHub already returns newest-first, but a published_at sort is
    // a cheap belt-and-braces against API quirks.
    .sort(
      (a, b) =>
        new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
    )[0];

  if (!candidate) return null;

  const findAsset = (name: string): string | null => {
    const a = candidate.assets.find((asset) => asset.name === name);
    return a?.browser_download_url ?? null;
  };

  return {
    tag: candidate.tag_name,
    name: candidate.name || candidate.tag_name,
    htmlUrl: candidate.html_url,
    publishedAt: candidate.published_at,
    arm64Url: findAsset(ARM64_ASSET),
    x64Url: findAsset(X64_ASSET),
  };
}

export async function GET(): Promise<NextResponse> {
  // Auth-gate: the install page is admin-only (see /admin/install). No
  // reason to expose this endpoint anonymously, and it spends our
  // GitHub-API budget. apiRequireUser is enough — we don't need to
  // duplicate the admin check here, the page itself already gates the
  // UI; any signed-in user hitting this directly would just see the
  // same DMG URL the GitHub release page already serves publicly.
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({ release: cached.info });
  }

  let info: CompanionReleaseInfo | null = null;
  try {
    info = await fetchLatestRelease();
  } catch {
    // Network blip — keep the prior cache if any, even if expired.
    if (cached) return NextResponse.json({ release: cached.info });
    return NextResponse.json({ release: null });
  }
  cached = { at: now, info };
  return NextResponse.json({ release: info });
}
