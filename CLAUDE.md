---
name: amaso-dashboard
description: Project-level instructions for Claude Code sessions in this repo. Wires up the brain/memory system.
---
# amaso-dashboard

Sparring-partner hub. Production at amaso.nl. Dashboard runs in production via the watchdog — never `npm run dev`. Restart with `powershell -File scripts/watchdog.ps1` (or kick the `AmasoDashboard-App` scheduled task).

## Brain / Memory System

A structured, multi-user brain lives at:

`C:\Users\santi\.claude\projects\C--Users-santi-projects-amaso-dashboard\memory\`

Every session — CLI or sparring-partner — uses it as long-term memory. Files are markdown with YAML frontmatter and cross-references in the form `see <path/file>, <section>`.

### Load order (every session)

1. **Read `MEMORY.md`** — the flat auto-memory index is already injected into context.
2. **Read `brain.md`** — the master index. It points to everything else and defines the file decay rules.
3. **Default user is Santi.** Load `users/santi/soul.md` and `users/santi/profile.md` to internalize who you're talking to and how to relate to him.
4. **Pull context-relevant files** as the conversation reveals what matters. The full mapping lives in `brain.md` under "Loading Protocol"; in short:
   - mentions a person → `people.md` + `users/<name>/profile.md`
   - mentions a project → `projects.md` + `decisions.md`
   - asks about plans/goals → `goals.md`
   - dates / birthdays → `users/santi/calendar.md`
   - technical problem → `lessons.md`
   - "what were we doing on X" → `users/santi/daily/<YYYY-MM-DD>.md`
   - reflecting on progress → `timeline.md`
5. **Daily log:** at session start, ensure today's daily log exists (see "Daily logs" below). Append throughout the session.
6. **Write-back:** when new facts surface (decisions made, projects shipped, people mentioned, preferences revealed), update the right file immediately. Read-modify-write. Don't batch; don't narrate.

Soul shapes everything but doesn't need to be re-read every turn — internalize it once.

### Write-back protocol

Detailed trigger rules for when and where to write live in `brain.md` under "Write-back Protocol". Key principle: if you hear it, write it. Don't wait. Don't batch. Read-modify-write the target file immediately. If you're in spar (no file access), route through graph/heartbeat/profile tools or create a remark tagged 'brain' for CLI pickup.

### Cross-reference format

Inside brain files, link with `see <path/file>, <section>`. Example: `see users/ilias/profile, financial-coaching` or `see decisions, css-overlay-over-pip`. Keep references stable when renaming sections.

### Daily logs

Two parallel logs per day:

- **Personal:** `users/<user>/daily/YYYY-MM-DD.md` — what happened for that user.
- **Shared:** `daily/YYYY-MM-DD.md` — team-level shipments, decisions, conversations.

If today's file is missing at session start, **create it** from the existing template (frontmatter + `## Shipped / Built / Decisions / Conversations / Open Loops / Energy` sections). Default user is Santi.

### Daily log decay

Apply opportunistically when you touch older logs — don't run a sweep:

| Age            | Detail level                                      |
|----------------|---------------------------------------------------|
| Today          | Fully detailed                                    |
| Yesterday      | Mostly detailed                                   |
| Last week      | Compress to highlights                            |
| Last month     | One-paragraph summary                             |
| Older          | Title + one sentence; promote anything load-bearing into `timeline.md` / `decisions.md` / `lessons.md` before compressing |

Decay is lossy by design. Anything that should survive decay must already be promoted into a durable file (`projects.md`, `decisions.md`, `lessons.md`, `timeline.md`). The compaction is the forcing function.

### Privacy / scoping

Per-user files (`users/<name>/`) are private to that user by default. Cross-user reads are allowed for genuine team needs (planning, coaching, conflict). **Only write** to other users' files when the user explicitly asks. Shared root-level files are open.

### Superseded files

The root-level `soul.md`, `user.md`, `preferences.md`, `calendar.md`, and `daily/` are kept for backward compatibility. Canonical source is now `users/santi/`. When updating, write to the per-user version. `brain.md` lists this explicitly.

### Sparring partner

`lib/spar-prompt.ts` references this same brain. The phone-driven sparring partner and the CLI both load from the same path so the persona stays consistent across channels.

## Roadmap (memory layer)

These are open architecture ideas that are **not yet built** — captured here so plans don't get rediscovered:

- **#253** — Research OpenClaw memory architecture for inspiration on layered memory.
- **#254** — Fact decay system (Hebbian activation): facts referenced often stay hot; unused facts cool and eventually compress. Replaces today's manual age-based decay.
- **#255** — Automatic fact extraction ("metabolism" layer): pull durable facts out of conversation transcripts on a schedule and write them into the right brain file without prompting. **2026-05-13 — first cut shipped as Smart Topic System Layer 4** (`lib/daily-extraction.ts` + `scripts/extract-daily-facts.ts` + scheduled task `AmasoDashboard-DailyExtraction` at 03:00 local). Haiku-driven, writes through `write_brain_file` semantics with HTML-comment citations + fingerprint idempotency. Hebbian decay (#254) remains future work; this layer is "extract on day-end", not "let referenced facts stay hot." **2026-05-14 — final pass:** closed remaining 7 layer-4 remarks. Added per-(user, date, topic) rollup (`lib/daily-topic-rollup.ts`), auto daily-log writer from subjects (`lib/daily-log-writer.ts`), lazy extraction trigger on `/api/spar/history/facts`, tightened subject prompt with verb-noun + 6-section heuristics, and made topics first-class to the spar AI via the `list_topics` tool, "Active topics today" prompt injection, per-message inline topic tags, sticky topic strip + per-day chip filters in mobile history.
- **#256** — Lossless context management via a summary DAG: every compaction step keeps a pointer to the unsummarized predecessor so older detail can be re-expanded on demand.
- **#257** — Unified memory search across all storage layers (brain files, knowledge graph, heartbeat, remarks, daily logs).

When working on any of these, link the implementation back to the corresponding remark ID.

## Repo conventions

- **Production restart:** always via the watchdog (`scripts/watchdog.ps1` / scheduled task `AmasoDashboard-App`). Never run `npm run dev` against the live install.
- **Dispatch + remarks:** primary I/O for Santi. Prefer `dispatch_to_project` and `create_remark` over inline shell tasks.
- **Voice-first:** any user-facing reply is played through Kokoro TTS. Plain prose, English, no markdown / lists / headings / code in spoken output.
- **No filler narration.** Just outcomes.

## Feature flags

- **`SMART_TOPICS_ENABLED`** (`lib/config.ts` → `isSmartTopicsEnabled()`, env-only, default **`false`**) — master kill-switch for all Smart Topic System **prompt injection** into the spar AI: the "Active topics today" header, inline `[topics: ...]` message tags, the `=== TOPIC SCOPE ===` composer-pill block, and the `list_topics` tool. Off by default because topic context was confusing the spar AI and pulling in wrong context. Only gates prompt injection — the daily-extraction job (`AmasoDashboard-DailyExtraction`) and all stored topics/facts/rollups keep running, and the mobile history topic UI is unaffected. Re-enable with `SMART_TOPICS_ENABLED=true` in `.env.local` + restart (no data migration).

## Security primitives (added during productization pass)

Before touching auth, sessions, or API routes, read [SECURITY.md](SECURITY.md). The dashboard has structured primitives — use them, don't reinvent.

- **Rate limiting:** `lib/rate-limit.ts` — `rateLimit({ name, key, max, windowMs })` + `rateLimitClear`. Use `ipFromRequest(req)` for the key.
- **SSRF guard:** `lib/url-guard.ts` — `await guardOutboundUrl(url)` before any `fetch()` driven by user input.
- **Audit log:** `lib/audit.ts` — `recordAudit({ action, actorId, actorEmail, actorIp, targetKind, targetId, meta })`. Action is a typed union; add to `AuditAction` if you need a new one. Append-only.
- **Error reporting:** `lib/observability.ts` — `reportError({ event, severity, cause, context })` or wrappers `withErrorReport()` / `withErrorReportAsync()`. Writes to `logs/errors.jsonl`.
- **Body limits:** `lib/body-limit.ts` per-route; global 50 MB ceiling in `middleware.ts`.
- **Middleware (`middleware.ts`):** same-origin check on state-changing API requests, security headers, CSP, HSTS in prod. Exempt routes MUST have their own auth (only `/api/telegram/*` today, gated by `X-Auth: TELEGRAM_VOICE_TOKEN`).

Wired hot-paths to know about:

- Auth flows audit success/fail. Login is rate-limited 5/15min per `(email, ip)`. Setup is rate-limited 10/1h per IP and race-safe via `db.transaction`.
- Session TTL is 7 days, not 30. Role change or password reset on a user **kills all their sessions** (admin route).
- `DELETE /api/account/sessions` lets a user log out everywhere; wired into the Settings panel.
- `GET /api/health` is the watchdog probe (200/503 + db check).
- `/admin/audit` is the audit log viewer (admin-only).
- `AUDIT_RETENTION_DAYS` env var controls log retention (default 365, 0 disables).
- `ERROR_WEBHOOK_URL` enables external sink for `reportError`.

Test coverage for the primitives lives in `tests/rate-limit.test.ts`, `tests/url-guard.test.ts`, `tests/audit.test.ts`, `tests/observability.test.ts`. Run before any change to the security-critical paths.
