import { getDb } from "@/lib/db";
import { collectFromClaudeCli } from "@/lib/spar-claude";

/**
 * Post-day extraction: consolidates a day's spar messages and topics into a
 * structured list of SubjectEntry objects via Claude. Results are cached in
 * the daily_subjects table so repeated calls for the same (user, date) are
 * free after the first run.
 */

export interface SubjectEntry {
  label: string;       // 2-4 words, sentence case, max 40 chars
  summary: string;     // 2-3 sentences: key decisions, outcomes, open items
  section: "Shipped" | "Decisions" | "Conversations" | "Open Loops" | "Energy" | "Built";
  topic_ids: number[]; // source topic IDs from the DB
  brain_refs: string[];// brain file paths that were touched (may be empty)
}

const SUBJECTS_MODEL = process.env.AMASO_SUBJECTS_MODEL || "sonnet";

/**
 * System prompt for the post-day subject consolidator. Encodes:
 *   #446 — consolidation rules (merge near-duplicate topics; fold
 *          sub-2-message topics into their nearest neighbor).
 *   #448 — labeling consistency (verb-noun, sentence case, max 40
 *          chars, no jargon — journal entries, not git commits).
 *   #455 — section classification heuristics for the 6 daily-log
 *          buckets (Shipped / Built / Decisions / Conversations /
 *          Open Loops / Energy).
 * Kept verbose because Sonnet/Haiku follow explicit instructions more
 * reliably than implicit conventions.
 */
const SYSTEM_PROMPT = [
  "You consolidate one day of conversation transcripts into a small, polished list of subjects.",
  "Output ONLY valid JSON — an array of SubjectEntry objects. No prose, no code fences.",
  "",
  "Consolidation rules:",
  "  - Merge topics that are clearly the same thing under different labels.",
  "    Example: \"Fixing mic\" + \"Mic issues\" → \"Mic setup\".",
  "  - Pick the most descriptive label out of the merge candidates.",
  "  - Fold any topic with fewer than 2 messages into its nearest neighbour by theme.",
  "  - Aim for 4–10 final subjects on a busy day; fewer on a quiet day. Never more than 15.",
  "",
  "Labeling rules:",
  "  - Verb-noun format. \"Shipping landing page\", \"Planning Q3 revenue\", \"Reviewing team roles\".",
  "  - Sentence case. Not Title Case, not lowercase.",
  "  - Max 40 characters.",
  "  - No technical jargon (write \"Fixing the audio glitch\" not \"Refactoring AudioWorklet\").",
  "  - Think journal entries, not git commits.",
  "  - All subjects for a day must look like they belong together — same style, same granularity.",
  "",
  "Section classification (each subject MUST land in exactly one):",
  "  - Shipped         — shipped / deployed / launched / went live / released / pushed to prod.",
  "  - Built           — built / coded / created / wrote / implemented / drafted.",
  "  - Decisions       — decided / going with / chose / locked in / called it.",
  "  - Conversations   — involves another person by name (Noah said …, lunch with X).",
  "  - Open Loops      — unresolved question / blocker / pending / waiting on / need to.",
  "  - Energy          — mood / energy / sleep / health / sobriety / focus / craving.",
  "When two sections could fit, prefer in order: Shipped > Decisions > Built > Conversations > Open Loops > Energy.",
].join("\n");

interface MessageRow {
  id: number;
  role: string;
  content: string;
  created_at: number;
}

interface TopicRow {
  message_id: number;
  topic_id: number;
  topic_title: string;
  topic_slug: string;
}

/**
 * Build the user prompt from raw DB rows. Groups messages by their attached
 * topics, caps individual messages at 800 chars to keep the prompt lean.
 */
function buildUserPrompt(messages: MessageRow[], topicRows: TopicRow[]): string {
  // Map message_id -> list of topic labels.
  const topicsByMsg = new Map<number, { id: number; title: string }[]>();
  for (const t of topicRows) {
    const arr = topicsByMsg.get(t.message_id) ?? [];
    arr.push({ id: t.topic_id, title: t.topic_title });
    topicsByMsg.set(t.message_id, arr);
  }

  // Group messages by their first topic (or "Untagged").
  const grouped = new Map<string, { topicId: number | null; msgs: MessageRow[] }>();
  for (const m of messages) {
    const topics = topicsByMsg.get(m.id);
    const key = topics && topics.length > 0 ? topics[0].title : "Untagged";
    const id = topics && topics.length > 0 ? topics[0].id : null;
    const cur = grouped.get(key) ?? { topicId: id, msgs: [] };
    cur.msgs.push(m);
    grouped.set(key, cur);
  }

  const lines: string[] = [];
  for (const [topicTitle, { topicId, msgs }] of grouped) {
    lines.push(`## Topic: ${topicTitle}${topicId !== null ? ` (id=${topicId})` : ""}`);
    for (const m of msgs) {
      const capped =
        m.content.length > 800 ? m.content.slice(0, 800) + " …" : m.content;
      lines.push(`[${m.role}] ${capped}`);
    }
    lines.push("");
  }

  lines.push(
    "Produce a JSON array of SubjectEntry objects. Apply the consolidation, " +
    "labeling, and section-classification rules from the system prompt. " +
    "Each subject has exactly these fields:",
    "  - label              verb-noun, sentence case, max 40 chars",
    "  - summary            2–3 sentences: what happened, key decisions, open items",
    "  - section            one of Shipped / Built / Decisions / Conversations / Open Loops / Energy",
    "  - topic_ids          array of source topic IDs (numbers, from this prompt)",
    "  - brain_refs         empty array (the brain-write pass populates this later)",
    "",
    "Return [] when no durable content for the day. No code fences. No leading prose.",
  );
  return lines.join("\n");
}

/**
 * Attempt to extract a SubjectEntry[] from raw CLI output. The model is
 * instructed to emit only JSON but sometimes wraps it in a code fence.
 */
function parseSubjects(raw: string): SubjectEntry[] {
  if (!raw.trim()) return [];
  const trimmed = raw.trim();
  // Try direct parse first.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as SubjectEntry[];
  } catch {
    /* fall through */
  }
  // Strip code fences and try again.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return parsed as SubjectEntry[];
    } catch {
      /* fall through */
    }
  }
  // Last resort: grab the first [...] block.
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed as SubjectEntry[];
    } catch {
      /* give up */
    }
  }
  return [];
}

/**
 * Pull all of the day's messages and their topic attachments from the DB.
 * Returns null when there are no messages for that (user, date) pair.
 */
function loadDayData(
  userId: number,
  date: string,
): { messages: MessageRow[]; topicRows: TopicRow[] } | null {
  const db = getDb();

  // Fetch all conversation IDs belonging to this user+date via daily_chats.
  const convIds = db
    .prepare(
      `SELECT DISTINCT conversation_id
         FROM daily_chats
        WHERE user_id = ? AND date_local = ?`,
    )
    .all(userId, date) as { conversation_id: number }[];

  if (convIds.length === 0) return null;

  const idList = convIds.map((r) => r.conversation_id);
  const placeholders = idList.map(() => "?").join(",");

  const messages = db
    .prepare(
      `SELECT id, role, content, created_at
         FROM spar_messages
        WHERE conversation_id IN (${placeholders})
          AND role IN ('user','assistant')
        ORDER BY created_at ASC`,
    )
    .all(...idList) as MessageRow[];

  if (messages.length === 0) return null;

  const msgIds = messages.map((m) => m.id);
  const msgPlaceholders = msgIds.map(() => "?").join(",");

  const topicRows = db
    .prepare(
      `SELECT smt.message_id, t.id AS topic_id, t.title AS topic_title, t.slug AS topic_slug
         FROM spar_message_topics smt
         JOIN topics t ON t.id = smt.topic_id
        WHERE smt.message_id IN (${msgPlaceholders})
        ORDER BY smt.relevance DESC`,
    )
    .all(...msgIds) as TopicRow[];

  return { messages, topicRows };
}

/**
 * Call Claude to extract subjects for the given (userId, date). Queries the
 * DB for messages, builds a prompt, calls the CLI, and returns the parsed
 * array. Returns [] on any error or when there's nothing to summarize.
 */
export async function extractDaySubjects(
  userId: number,
  date: string,
): Promise<SubjectEntry[]> {
  const data = loadDayData(userId, date);
  if (!data) return [];

  const userPrompt = buildUserPrompt(data.messages, data.topicRows);
  let cliOutput = "";
  try {
    cliOutput = await collectFromClaudeCli({
      systemPrompt: SYSTEM_PROMPT,
      heartbeat: "",
      history: [{ role: "user", content: userPrompt }],
      model: SUBJECTS_MODEL,
      maxTurns: 1,
    });
  } catch (err) {
    console.warn(
      "[spar-subjects] extractDaySubjects CLI failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }

  try {
    return parseSubjects(cliOutput);
  } catch {
    return [];
  }
}

/**
 * Check daily_subjects for a cached result; if found return it. Otherwise
 * call extractDaySubjects, persist the result, and return it.
 */
export async function getOrExtractSubjects(
  userId: number,
  date: string,
): Promise<SubjectEntry[]> {
  const db = getDb();

  // Check cache.
  const cached = db
    .prepare(
      `SELECT subjects FROM daily_subjects WHERE user_id = ? AND date = ?`,
    )
    .get(userId, date) as { subjects: string } | undefined;

  if (cached) {
    try {
      return JSON.parse(cached.subjects) as SubjectEntry[];
    } catch {
      // Corrupt cache row — fall through to re-extract.
    }
  }

  const subjects = await extractDaySubjects(userId, date);

  // Persist (upsert — re-extraction overwrites stale cache).
  try {
    db.prepare(
      `INSERT INTO daily_subjects (user_id, date, subjects, generated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET subjects = excluded.subjects,
                                                  generated_at = excluded.generated_at`,
    ).run(userId, date, JSON.stringify(subjects), Date.now());
  } catch (err) {
    console.warn(
      "[spar-subjects] failed to cache daily_subjects:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Remark #453: auto-populate the user's daily log from the
  // consolidated subjects. Read-modify-write so manual entries stay
  // intact; the writer's fingerprint guard makes re-runs idempotent.
  // Fire-and-forget — we never want a slow disk write to block the
  // subjects API response.
  if (subjects.length > 0) {
    void (async () => {
      try {
        const userRow = db
          .prepare(
            "SELECT id, email, name, role, created_at FROM users WHERE id = ?",
          )
          .get(userId) as
          | {
              id: number;
              email: string;
              name: string;
              role: "admin" | "team" | "client";
              created_at: number;
            }
          | undefined;
        if (!userRow) return;
        const { writeDailyLogFromSubjects } = await import("./daily-log-writer");
        const result = await writeDailyLogFromSubjects(
          userRow,
          date,
          subjects,
        );
        console.log(
          `[spar-subjects] daily-log write user=${userId} date=${date} ` +
            `path=${result.relPath} written=${result.written} ` +
            `dup-skipped=${result.skippedDuplicate} existed=${result.fileExisted}`,
        );
      } catch (err) {
        console.warn(
          "[spar-subjects] daily-log write failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }

  return subjects;
}
