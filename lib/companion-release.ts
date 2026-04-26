/**
 * Shared shape for `/api/companion/latest-release`. Lives in `lib/`
 * (and not in the route file) so client components can `import type`
 * it without dragging the route's `next/server` imports into the
 * client bundle. Importing from a `route.ts` file directly is a known
 * footgun in Next's app-router bundler — type-only imports are
 * supposed to be erased, but the route-tracing pass occasionally
 * pulls server runtime code into the client chunk and breaks
 * hydration / CSS loading on the page that did the import.
 */
export interface CompanionReleaseInfo {
  /** Tag name on GitHub, e.g. "companion-v1.0.0". */
  tag: string;
  /** Human title for the card subline. */
  name: string;
  /** Public release page on GitHub. Used for "view release notes". */
  htmlUrl: string;
  publishedAt: string;
  /** Direct DMG asset URLs. Either may be null if a release exists
   *  but the matching arch slice didn't upload (e.g. partial CI run). */
  arm64Url: string | null;
  x64Url: string | null;
}
