# Smart Topic System — implementation plan

Status:
- Layer 0 shipped — DB schema + lib/topics.ts, per-user. Templater
  shipped (lib/brain-vars.ts).
- Layer 1 shipped — topic detection on user messages (lib/topic-detect.ts).
- Layer 2 shipped — smart context window (lib/spar-topic-context.ts).
- Layer 3 shipped — single daily chat (daily_chats table, getOrCreateDailyChat,
  rollover broadcast). Tests in tests/daily-chat.test.ts.
- **Layer 4 shipped 2026-05-13** — nightly post-day fact extraction. See the
  "Layer 4 — post-day extraction (SHIPPED)" section below for what actually
  landed vs. the original plan.

This doc is the spec for the remaining layers so we don't invent
architecture mid-build.

## Goal

Every spar message lives inside one ongoing daily chat per user, but
durable understanding emerges as **topics** — slug-addressable threads
that can be revisited, summarized, and woven into the brain. A topic is
"the project meridian app", "money anxiety", "the Outlook automation",
etc. Topics persist across days; the daily chat is the live stream;
extraction reconciles the two each night.

## Architecture (seven layers)

| # | Layer | Status | Owns |
|---|---|---|---|
| 0 | DB schema | shipped | `topics`, `spar_message_topics`, `lib/topics.ts`. Per-user. UNIQUE(user_id, slug). |
| 1 | Topic detection | not built | Classify each new user message → list of `(topic, relevance)`. Live, on persist. |
| 2 | Context window | not built | Build the assistant's context from topic membership instead of recency. |
| 3 | Single daily chat | not built | One conversation per user per day. Auto-rolled at local midnight. |
| 4 | Post-day extraction | not built | Nightly pass: re-cluster, merge near-duplicate topics, write summaries. |
| 5 | History UI | not built | Topic browser in dashboard: list topics, drill into messages. |
| 6 | Brain integration | not built | Promote durable topic facts into per-user / global brain files. |

## Layer-by-layer

### Layer 1 — topic detection

Trigger: `appendMessage` in `lib/spar-conversations.ts`, role=user. Fire
detection asynchronously after the message row is committed so the write
path stays sync.

Detection function signature:

```ts
detectTopicsForMessage(messageId: number, userId: number): Promise<{ topicId: number; relevance: number }[]>
```

Implementation:

1. Pull the user's last N user messages (default 8) joined with their
   active topics (max ~30 active per user) — this is the candidate set.
2. Heuristic pre-filter: tokenize the new message, compute Jaccard
   overlap with each active topic's title + slug + last-3-message
   excerpts. Anything ≥0.35 is auto-attached at relevance = the score.
3. Model classifier (Haiku) for the remaining decision: "given these
   N candidate topics and this message, return JSON `{matches:
   [{slug, relevance}], new_topic?: { title, summary } | null}`."
   Cap input at 4k tokens. One call per user message, fire-and-forget.
4. Resolve matches via `getTopicBySlug(userId, slug)`; if `new_topic`
   came back, `createTopic` first then attach.
5. `attachMessageToTopic` for each result. Idempotent — replays are
   safe.

Failure modes:
- Model unreachable → heuristic-only path still attaches, so the chat
  isn't blocked.
- No matches and no new topic → the message is unattached. Layer 4 will
  pick it up.
- Same message detected twice (race) → join PK absorbs the duplicate.

Out of scope for Layer 1: assistant-message classification, multi-topic
relevance reweighting, topic merging.

### Layer 2 — context window

Replace the assistant's "last N messages" recency window with a
topic-anchored window:

```ts
buildContextForUser(userId, currentMessageId): { messages, topics }
```

1. Run Layer 1 synchronously on the current user message (fast path
   without the model call — heuristic only) to get a candidate topic
   set.
2. For each topic in the set, pull `listMessagesForTopic(topicId,
   { limit: 20 })` — these are the topic's most recent messages.
3. Dedupe + sort by created_at, cap at ~3000 tokens.
4. Append the live tail (last 6 messages of today's chat) regardless,
   so short-term coherence is preserved.

This is the layer where the topic system pays off — the assistant
suddenly remembers everything you said about meridian-app two weeks
ago, even though it's not in the recency window.

### Layer 3 — single daily chat

One `spar_conversations` row per user per local day. Schema is already
sufficient — add a `daily_date TEXT` column (`YYYY-MM-DD`) for fast
lookup, plus `UNIQUE(user_id, daily_date)` to make the roll idempotent.

`getOrCreateDailyConversation(userId)` returns today's row, creating it
on first call after midnight. The sidebar collapses old daily chats into
a date-grouped list; the live one is pinned at the top.

Migration: existing conversations stay as-is (daily_date NULL). Only new
ones get the date.

### Layer 4 — post-day extraction (SHIPPED 2026-05-13)

Implemented as `lib/daily-extraction.ts` + `scripts/extract-daily-facts.ts`
+ `scripts/register-extraction-task.ps1` + `app/api/admin/extract-facts/route.ts`.
The shipped scope differs from the original plan in three deliberate ways
— recorded here so future passes don't re-invent the architecture:

1. **Goal change.** The original plan framed Layer 4 as a topic-management
   pass (merges / splits / topic summaries). The shipped scope is what the
   user spec actually asked for: **extract durable facts and write them into
   the right brain files**, with citations. Topic re-clustering is left to a
   separate future pass (no remarks demanded it in the current open set).
2. **Model.** Haiku 4.5 (`claude-haiku-4-5-20251001`), called directly via
   `@anthropic-ai/sdk` — already in deps. Strict-JSON output enforced by a
   tight system prompt with the brain.md scope rules baked in.
3. **Storage.** New `daily_extractions` table — one row per (user_id, date)
   with status (`pending`/`success`/`failed`/`skipped`), fact_count,
   per-classification counts, source_message_ids, and error_text. Complements
   the existing `daily_subjects` table (which fuels the history UI, not the
   brain).

Pipeline (in `extractDailyFacts`):

1. Load the user's full transcript for the requested local date via
   `daily_chats` → `spar_messages` (user + assistant rows only).
2. Build the prompt with the brain.md file-scope rules + the per-user slug.
3. Call Haiku; require an array of `{fact, classification, brain_file,
   section, source_message_ids[]}`. The 11 valid classifications are pinned
   in `VALID_CLASSIFICATIONS`. Anything off-list is rejected with a count
   in the audit row.
4. For each accepted fact, resolve the target brain file against a per-user
   allowlist (escape protection + slug pinning), append under the named H2
   section using read-modify-write, and write an HTML-comment citation
   `<!-- extracted from daily chat YYYY-MM-DD, messages: ... -->` directly
   beneath the fact. Idempotent on fact-content fingerprints — reruns are
   no-ops unless the fact body has changed.
5. Persist a `daily_extractions` row with the full classification breakdown
   and the source_message_ids for audit. Both `logs/daily-extractions.log`
   (per-line summary) and `logs/extraction-cron.log` (npm wrapper stdout)
   capture the run.

CLI / cron / admin surfaces:

- **CLI** — `npm run extract-facts -- --date YYYY-MM-DD --user <name|id>
  [--force] [--dry-run]`. Defaults: yesterday in Europe/Amsterdam, santi,
  no force, real writes.
- **Cron** — `powershell -File scripts/register-extraction-task.ps1`
  registers `AmasoDashboard-DailyExtraction` to run nightly at 03:00 local.
  Idempotent (unregister-then-register). Does NOT touch the watchdog task.
- **Admin endpoint** — `POST /api/admin/extract-facts` with
  `{ date, userId, force, dryRun }`. Gated by `apiRequireAdmin`. Useful for
  rerunning extraction from the dashboard without an SSH session.
- **Dependency injection** — `extractor` and `brainRoot` options on
  `extractDailyFacts` mean tests run against a tmp brain root with a
  stubbed Anthropic call. No new SDK was added — `@anthropic-ai/sdk` was
  already in deps via `lib/spar-sdk.ts`.

Tests in `tests/daily-extraction.test.ts` (10 cases) cover JSON parsing,
allowlist rejection, full pipeline against a seeded DB fixture, dry-run
no-op semantics, rerun-without-force skip, and rerun-with-force duplicate
fingerprint short-circuit.

Out of scope (intentionally left to future passes):

- Topic re-clustering / merges / splits (the original L4 framing).
- Promoting topic summaries into brain files based on activity thresholds
  (that's Layer 6 territory — `#477` through `#482` in the remarks).
- Daily-log section auto-population that the open `#453` remark proposes;
  the current pipeline writes to `users/<slug>/daily/YYYY-MM-DD.md` only
  when the model classifies a fact as `daily-log-summary`. The section
  classifier in the prompt routes to Shipped/Built/Decisions/Conversations/
  Open Loops/Energy already, but smarter heuristic backups (the `#455`
  remark) are not implemented.

### Layer 5 — history UI

New route `/topics` in the dashboard:

- Sidebar: list active topics for current user, sorted by
  last_active_at, with message count + relative date.
- Main: drill into a topic → message list (reuse spar transcript
  rendering), summary at top, ability to archive / rename.
- Search: substring match over topic titles + summaries (cheap LIKE
  query — the dataset stays small).

API surface: `GET /api/topics`, `GET /api/topics/:slug`, `PATCH
/api/topics/:slug`. All scoped to the session user.

### Layer 6 — brain integration

When a topic crosses thresholds — say message_count ≥ 20, or
last_active_at within last 7 days plus age ≥ 14 days — promote its
summary into a brain file:

- Project-flavored topics → entry in global `projects.md`.
- Person-flavored topics → entry in global `people.md` + that person's
  `users/<name>/profile.md`.
- Personal-pattern topics → `users/<user>/profile.md` or
  `lessons.md` depending on shape.

Detection of "flavor" runs through Haiku once per promotion. The
templater (`lib/brain-vars.ts`) is already in place so promoted entries
can reference `{{user.name}}` etc. without duplication.

Promotion is one-way: brain files are the durable record. Topics keep
existing in case they get reactivated.

## Open decisions before Layer 1

1. **Model choice for live classification.** Haiku 4.5 is the obvious
   pick (fast, cheap, JSON-mode). Confirm budget / latency target.
2. **Heuristic threshold.** Start at Jaccard ≥0.35 → auto-attach. Tune
   from logs after a week.
3. **Max active topics per user.** Cap at 50? 100? Past that, Layer 4
   archives the cold ones.
4. **Should assistant messages also be classified?** Default no — they
   inherit the user message's topics. Re-evaluate after Layer 5 ships.

## Risks

- **Topic sprawl.** Detection without merging produces 200 noisy
  topics in a month. Layer 4 has to ship within ~1 week of Layer 1 or
  the system feels broken.
- **Latency.** Classification on every user message adds round-trip
  time. Mitigation: fire-and-forget on persist, run heuristic-only
  synchronously where the context window needs it.
- **Cold start.** First few days, topic memberships are sparse and the
  context window falls back to recency. Not a bug, but worth flagging
  in the UI ("new topic — building memory").

## Rollout

Behind a per-user flag (`topics_enabled` on autopilot_users or a
similar table). Default off. Enable for Santi first, verify Layers 1+2
work in practice, then enable for ilias/noah.
