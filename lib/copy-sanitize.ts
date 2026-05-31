/**
 * Copy sanitizer — hard rule (remark #524).
 *
 * No em-dash (—, U+2014) or en-dash (–, U+2013) may reach user-facing
 * output. They keep creeping back into generated copy despite prompt
 * guidance, so instead of relying on the model we strip them at the
 * output chokepoints: the spar stream's `onText` (covers the chat UI and
 * the persisted reply) and the Kokoro TTS synth entry (covers every
 * spoken path). This overrules any other copy guideline.
 *
 * Replacement is " - " (space-hyphen-space). Any spaces/tabs already
 * around the dash are collapsed into the single replacement so we don't
 * produce double spaces; newlines are preserved. Idempotent — running it
 * on already-sanitized text is a no-op.
 */
export function stripEmDashes(text: string): string {
  if (!text) return text;
  return text.replace(/[ \t]*[—–][ \t]*/g, " - ");
}
