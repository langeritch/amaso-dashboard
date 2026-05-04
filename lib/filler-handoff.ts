/**
 * Client-side coordinator for the filler → real-TTS handoff.
 *
 * Every filler audio source (ambient pad, news WAV pool, fun-facts /
 * calendar TTS) registers itself here and reports two things:
 *
 *   1. A *stop handler* — called when SparProvider needs all filler
 *      audio to begin fading out RIGHT NOW because real TTS is about
 *      to start.
 *   2. An *audible flag* — flipped true while the source is actually
 *      producing sound, false the moment its fade-out completes.
 *
 * SparProvider's `playNextTts` then calls `awaitFillerHandoff(150)`
 * before invoking `el.play()`. The function:
 *   - returns instantly if no source is currently audible (the
 *     gapless within-turn case — chunk N+1 doesn't insert a breath
 *     mid-sentence)
 *   - otherwise triggers every stop handler and waits until every
 *     source has reported audible=false, then waits an additional
 *     bufferMs (~150 ms breath) before resolving.
 *
 * A 1.5 s safety timeout keeps a misbehaving source from pinning
 * the real reply forever — at worst we get a tiny audible overlap,
 * never a stuck UI.
 *
 * Module-scope: there's exactly one Spar audio session per tab, and
 * coupling this state to React renders would mean every filler hook
 * has to thread refs through props it otherwise wouldn't need. The
 * coordinator stays a singleton; hooks pull from it on mount.
 */

type SourceId = string;

const audible = new Set<SourceId>();
const stopHandlers = new Map<SourceId, () => void>();
const listeners = new Set<() => void>();

const HANDOFF_SAFETY_TIMEOUT_MS = 1_500;

/** Mark a source as currently producing sound (true) or fully
 *  silent (false). Idempotent. */
export function setFillerAudible(id: SourceId, isAudible: boolean): void {
  const had = audible.has(id);
  if (isAudible) audible.add(id);
  else audible.delete(id);
  if (had !== audible.has(id)) notify();
}

/** Register a stop handler. The returned cleanup also clears any
 *  audible flag the source had, so a hook that unmounts mid-playback
 *  doesn't leave a phantom entry in the audible set. */
export function registerFillerStopHandler(
  id: SourceId,
  handler: () => void,
): () => void {
  stopHandlers.set(id, handler);
  return () => {
    stopHandlers.delete(id);
    if (audible.delete(id)) notify();
  };
}

export function isAnyFillerAudible(): boolean {
  return audible.size > 0;
}

/**
 * Trigger every registered stop handler and wait for all sources to
 * report silent. Adds `bufferMs` of breath before resolving so the
 * filler→answer transition feels like a natural pause instead of a
 * hard cut. Resolves immediately when nothing is audible at call
 * time — that path is the within-turn TTS chunk case where adding a
 * gap would make speech sound choppy.
 */
export function awaitFillerHandoff(bufferMs = 150): Promise<void> {
  if (audible.size === 0) return Promise.resolve();
  for (const h of stopHandlers.values()) {
    try {
      h();
    } catch {
      /* one bad handler shouldn't block the others */
    }
  }
  // Re-check after dispatch — a synchronous stop handler that flipped
  // its own audible=false (rare, but possible for sources that haven't
  // actually started yet) means we can skip the wait + just breathe.
  if (audible.size === 0) {
    return new Promise((r) => setTimeout(r, bufferMs));
  }
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      listeners.delete(onChange);
      resolve();
    }, HANDOFF_SAFETY_TIMEOUT_MS);
    const onChange = () => {
      if (resolved) return;
      if (audible.size === 0) {
        resolved = true;
        clearTimeout(timer);
        listeners.delete(onChange);
        setTimeout(resolve, bufferMs);
      }
    };
    listeners.add(onChange);
  });
}

/** Subscribe to audibility changes. Returns an unsubscribe function. */
export function onFillerAudibleChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Subscribe to "is any filler currently audible?" with the current
 *  value pushed immediately and on every change. Returns an unsubscribe.
 *  Use this when a consumer needs to react to filler audio start/stop
 *  (e.g. mic gating) — it removes the boilerplate of pairing
 *  onFillerAudibleChange with isAnyFillerAudible. */
export function subscribeFillerAudible(
  cb: (audible: boolean) => void,
): () => void {
  cb(audible.size > 0);
  let last = audible.size > 0;
  const wrapped = () => {
    const now = audible.size > 0;
    if (now === last) return;
    last = now;
    cb(now);
  };
  listeners.add(wrapped);
  return () => { listeners.delete(wrapped); };
}

function notify(): void {
  // Snapshot — a listener removing itself during iteration would
  // otherwise skip the next entry.
  for (const l of [...listeners]) l();
}
