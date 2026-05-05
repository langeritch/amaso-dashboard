/**
 * Module-scope client handle for the live YouTube iframe.
 *
 * The iframe lives inside `useYoutubeFiller`, which is mounted by
 * `useMediaPlayer` deep in the SparProvider tree. The mini-player /
 * media drawer is a peer component and has no direct access to the
 * `YT.Player` instance — but features like a draggable scrubber need
 * to call `seekTo()` *now*, not via a server round-trip.
 *
 * Mirrors `filler-handoff.ts`: the iframe hook publishes a thin handle
 * here on mount and clears it on unmount; consumers (the drawer) read
 * from it without prop-drilling. Single source of truth at the module
 * level is fine because there's exactly one player per tab.
 *
 * If no handle is registered (player not yet ready, or unmounted),
 * the read functions return null and the drawer falls back to its
 * server-derived position — better than throwing during the brief
 * mount race after a refresh.
 */

export interface YoutubePlayerHandle {
  /** Returns the current playhead in seconds, or null if the player
   *  isn't queryable yet. The drawer prefers this over the polled
   *  positionSec because the poll lags by up to 100 ms — enough to
   *  make the scrubber stutter under the user's drag. */
  getCurrentTime: () => number | null;
  /** Seek to the given second. allowSeekAhead=true asks YT to fetch
   *  the correct chunk rather than playing silence to the target. */
  seekTo: (sec: number) => void;
  /** The wrapper <div> the iframe lives inside. The Picture-in-Picture
   *  toggle moves this element into a popped-out browser window (or
   *  repositions it on-screen as a fallback) so the user sees the
   *  video. Returns null when the player hasn't mounted yet. */
  getMount: () => HTMLElement | null;
}

let handle: YoutubePlayerHandle | null = null;

export function registerYoutubePlayerHandle(
  next: YoutubePlayerHandle,
): () => void {
  handle = next;
  return () => {
    if (handle === next) handle = null;
  };
}

export function seekYoutube(sec: number): void {
  if (!handle) return;
  if (!Number.isFinite(sec) || sec < 0) return;
  try {
    handle.seekTo(sec);
  } catch {
    /* player races / not ready — drop the seek; user can retry */
  }
}

export function getYoutubeCurrentTime(): number | null {
  if (!handle) return null;
  try {
    return handle.getCurrentTime();
  } catch {
    return null;
  }
}

/** Read the player wrapper element so the PiP toggle can move it
 *  into a popped-out window. Returns null when the iframe hasn't
 *  mounted (no video selected, or pre-ready). */
export function getYoutubeMount(): HTMLElement | null {
  if (!handle) return null;
  try {
    return handle.getMount();
  } catch {
    return null;
  }
}
