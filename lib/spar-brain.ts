import fs from "node:fs";
import path from "node:path";

/**
 * Loads the structured brain markdown files into a single block for the
 * spar system prompt. Mirrors the loading protocol the CLI follows per
 * CLAUDE.md so the phone-driven assistant has the same long-term memory
 * surface area as a CLI session.
 *
 * Files that don't exist on disk are skipped silently — the brain is a
 * living tree and not every install populates every file.
 */

/** Filesystem root for the structured brain. Exported so the spar
 *  brain-file tools (read_brain_file / write_brain_file /
 *  list_brain_files) reuse the same constant instead of hardcoding
 *  the path twice. Override with AMASO_BRAIN_ROOT for non-default
 *  installs (e.g. dev sandboxes). */
export const BRAIN_ROOT =
  process.env.AMASO_BRAIN_ROOT ||
  "C:\\Users\\santi\\.claude\\projects\\C--Users-santi-projects-amaso-dashboard\\memory";

interface BrainFileSpec {
  /** Path relative to BRAIN_ROOT. */
  rel: string;
  /** Short label used in the prompt section header AND as the source chip. */
  label: string;
}

const BRAIN_FILES: BrainFileSpec[] = [
  { rel: "brain.md", label: "brain.md" },
  { rel: "users/santi/soul.md", label: "soul.md" },
  { rel: "users/santi/profile.md", label: "profile.md" },
  { rel: "users/santi/preferences.md", label: "preferences.md" },
  { rel: "users/santi/calendar.md", label: "calendar.md" },
  { rel: "goals.md", label: "goals.md" },
  { rel: "projects.md", label: "projects.md" },
  { rel: "decisions.md", label: "decisions.md" },
  { rel: "lessons.md", label: "lessons.md" },
  { rel: "people.md", label: "people.md" },
  { rel: "timeline.md", label: "timeline.md" },
];

export interface BrainContext {
  /** Pre-formatted prompt block. Empty string when nothing loaded. */
  block: string;
  /** Labels of files that were actually read (suitable for source chips). */
  loaded: string[];
}

export function loadBrainContext(): BrainContext {
  const sections: string[] = [];
  const loaded: string[] = [];
  for (const spec of BRAIN_FILES) {
    const abs = path.join(BRAIN_ROOT, spec.rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8").trim();
    } catch {
      continue;
    }
    if (!content) continue;
    sections.push(
      `=== BRAIN: ${spec.label} ===\n${content}\n=== END BRAIN: ${spec.label} ===`,
    );
    loaded.push(spec.label);
  }
  if (sections.length === 0) return { block: "", loaded: [] };
  return { block: sections.join("\n\n"), loaded };
}
