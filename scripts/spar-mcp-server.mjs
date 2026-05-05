#!/usr/bin/env node
// Minimal stdio MCP server the Claude CLI spawns for the spar route.
// Proxies tool calls back to the dashboard via a loopback HTTP endpoint,
// authed with a short-lived token passed in env. Handwritten JSON-RPC to
// avoid pulling the MCP SDK into this repo — the protocol surface we need
// is tiny (initialize, tools/list, tools/call).

import readline from "node:readline";
import process from "node:process";

const TOKEN = process.env.AMASO_SPAR_TOKEN;
const DASHBOARD_URL = process.env.AMASO_DASHBOARD_URL || "http://127.0.0.1:3737";

if (!TOKEN) {
  process.stderr.write("[spar-mcp] AMASO_SPAR_TOKEN required\n");
  process.exit(1);
}

const TOOLS = [
  {
    name: "list_projects",
    description:
      "List all projects visible to the user, with dev-server info and whether a Claude Code terminal is running. Use when the user references a project vaguely or you need to pick which one to inspect.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "describe_project",
    description:
      "Full details about one project: path, dev port, preview URL, live URL, terminal state, and the last 5 file changes. Use once per project you're focusing on instead of hitting several smaller tools.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id, e.g. 'neva17'" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_heartbeat",
    description:
      "Read the user's heartbeat markdown — the running note of what's on their plate, deadlines, and open loops. Read this before offering life advice or accountability nudges.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_terminal_scrollback",
    description:
      "Read the tail of the Claude Code terminal output for a specific project. Returns ANSI-stripped text by default plus a 'state' hint ('permission_gate' / 'thinking' / 'at_prompt' / 'unknown') and a plain-English 'hint'. TRUST the state hint over raw text interpretation. Pass raw:true to get unprocessed bytes (ANSI escapes, status lines, all chrome intact) when you need the full firehose. Only works if a terminal session is running. The PTY ring buffer holds ~1 MB (~10k lines) per project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id, e.g. 'neva17'" },
        tail_chars: {
          type: "integer",
          description: "How many bytes from the end to return. Default 16000, min 500, max 262144 (256 KB).",
        },
        raw: {
          type: "boolean",
          description: "When true, skip ANSI/TUI-chrome stripping and return raw PTY bytes. Default false.",
        },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recent_file_changes",
    description:
      "List the most recent file add / edit / delete events in a project. Use when the user asks 'what changed' or you need to know which files were just touched.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        limit: { type: "integer", description: "How many entries (default 20, max 50)." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recent_remarks",
    description:
      "List recent remarks/notes — the user's queue of pinned items, ideas, and bugs. Newest first. Every returned remark has: id, projectId, body, tags[], createdAt, updatedAt, resolved (boolean), resolvedAt. All filters are optional and combine with AND:\n" +
      "• project_id: scope to one project. Omit to see remarks across every project the user can access.\n" +
      "• resolved: true → only resolved items. false → only open items. Omit for both.\n" +
      "• tag: case-insensitive exact-match on any tag. Use when the user asks 'what's on my bug list' / 'show me ideas'.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        limit: { type: "integer", description: "How many (default 10, max 50)." },
        resolved: {
          type: "boolean",
          description: "Filter by resolved status. Omit for both.",
        },
        tag: { type: "string", description: "Exact tag to filter by (case-insensitive)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_remark",
    description:
      "Create a new remark / note for a project. Use when the user tells you about an open item, a bug to fix later, or an idea worth capturing. Be decisive — don't pepper the user with 'should I write that down?' for every passing thought; capture the concrete ones and move on.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id the remark belongs to." },
        content: {
          type: "string",
          description:
            "The note itself. Plain prose, concrete, a few sentences at most. Leading bullet characters are fine but markdown won't render in the UI.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional free-form tags for grouping ('bug', 'ui', 'later', 'decision'). Lowercase by convention but not enforced. Max 20 tags, 40 chars each.",
        },
      },
      required: ["project_id", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_remark",
    description:
      "Edit an existing remark. At least one of content or tags must be provided. Pass tags as the FULL new array (replaces the old list — to add one, read first and submit the combined array). Updates the updated_at timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        remark_id: { type: "integer", description: "Id of the remark to edit." },
        content: {
          type: "string",
          description: "New body text. Omit to leave it alone.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "New tag list, REPLACING the existing one. Omit to leave tags alone.",
        },
      },
      required: ["remark_id"],
      additionalProperties: false,
    },
  },
  {
    name: "resolve_remark",
    description:
      "Mark a remark as resolved / done. Sets resolved_at to now. Use when the user says they shipped / handled / fixed the item, or after a dispatch confirms the work landed.",
    inputSchema: {
      type: "object",
      properties: {
        remark_id: { type: "integer", description: "Id of the remark." },
      },
      required: ["remark_id"],
      additionalProperties: false,
    },
  },
  {
    name: "unresolve_remark",
    description:
      "Reopen a previously-resolved remark. Clears resolved_at. Use when the user pulls an item back out (regression, changed their mind, shipped partially).",
    inputSchema: {
      type: "object",
      properties: {
        remark_id: { type: "integer", description: "Id of the remark." },
      },
      required: ["remark_id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_remark",
    description:
      "Permanently delete a remark and its attachments. Irreversible — use only when the user explicitly asks to delete (not just resolve). If in doubt, resolve_remark instead so we keep the history.",
    inputSchema: {
      type: "object",
      properties: {
        remark_id: { type: "integer", description: "Id of the remark to delete." },
      },
      required: ["remark_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_project_file",
    description:
      "Read a small text file from a project, scoped to the project root. Files over 32 KB are truncated. Prefer scrollback / remarks / file-change lists for most questions; reach for this tool only when you actually need to see the code.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        rel_path: {
          type: "string",
          description: "Path relative to the project root, e.g. 'app/page.tsx'",
        },
      },
      required: ["project_id", "rel_path"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_to_project",
    description:
      "Send a crafted prompt directly into a project's Claude Code terminal. This fires immediately — there is no second-turn confirm step. Safety is on you: before calling this, describe the prompt to the user in plain spoken prose (what you're about to ask the project's Claude to do) and get a verbal yes. Only call this tool once the user has said go / yes / send it / do it. If you're unsure, don't call it — ask again. Craft the prompt carefully: it is the actual instruction Claude Code receives, so be specific, name the files, spell out constraints, reference prior discussion. Don't speak tool names, ids, or any of this machinery aloud to the user.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id, e.g. 'neva17'" },
        prompt: {
          type: "string",
          description:
            "Full instruction for the project's Claude Code terminal. Concrete, grounded in context you've already gathered, ready to run.",
        },
      },
      required: ["project_id", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "send_keys_to_project",
    description:
      "Send raw keystrokes to a project's Claude Code terminal. Use for interacting with in-TUI prompts and menus — approving a permission gate ('1' + <enter>), scrolling (<up>/<down>), dismissing (<esc>), etc. Named tokens: <enter>, <up>, <down>, <left>, <right>, <esc>, <tab>, <bs>, <space>. Plain characters pass through as typed. No auto-Enter — include <enter> if you need to submit. Prefer dispatch_to_project for full instruction prompts; use this only for keystroke-level interaction with what Claude Code is already showing.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        keys: {
          type: "string",
          description:
            "Keys to send, e.g. '1<enter>' to pick menu option 1, 'y<enter>' for a yes prompt, '<esc>' to cancel.",
        },
      },
      required: ["project_id", "keys"],
      additionalProperties: false,
    },
  },
  {
    name: "read_graph",
    description:
      "Read the user's knowledge graph — a JSON record of projects and their status, open commitments and deadlines, active blockers, open decisions, key people, cross-project connections, and recent milestones. Read this early in a session and when the user references anything that might already be tracked (a project, a person, 'where were we on X', 'what's blocking Y'). Much cheaper than re-deriving from scrollback or the heartbeat. Returns the full graph as JSON.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "write_graph",
    description:
      "Update the knowledge graph by supplying a JSON 'graph' object. Top-level keys you pass REPLACE the existing ones; keys you omit are preserved on disk. So to add a commitment: read_graph → append to the commitments array → write_graph with {commitments: [...fullNewArray]}. Schema (all fields optional except where noted):\n" +
      "• projects: { <id>: { status: 'active'|'paused'|'shipped'|'archived', name?, notes?, lastTouched? } }\n" +
      "• commitments: [{ id, description, dueAt?, projectId?, toWhom?, status: 'open'|'done'|'cancelled', notes? }]\n" +
      "• blockers: [{ id, description, projectId?, openedAt, resolvedAt?, status: 'open'|'resolved', notes? }]\n" +
      "• decisions: [{ id, question, projectId?, status: 'open'|'decided', decision?, notes? }]\n" +
      "• people: { <key>: { name, role?, projects?, notes? } }\n" +
      "• connections: [{ from, to, kind, note? }]  — kind is free-form: 'shared_codebase', 'blocks', 'depends_on', 'same_client', etc.\n" +
      "• milestones: [{ id, description, projectId?, achievedAt, notes? }]\n" +
      "Keep entries terse. Update when a major event lands: new commitment, blocker opened or resolved, deadline set, decision made, milestone hit, project status flips. Don't announce updates to the user — just do them.",
    inputSchema: {
      type: "object",
      properties: {
        graph: {
          type: "object",
          description: "Partial graph object. Top-level keys present here replace their on-disk counterparts.",
        },
      },
      required: ["graph"],
      additionalProperties: false,
    },
  },
  {
    name: "update_heartbeat",
    description:
      "Overwrite the user's heartbeat markdown with a new body. Use this proactively to keep the heartbeat current: when the user tells you about a new commitment, deadline, decision, or resolves an existing item, update the file so it reflects reality. Read the current heartbeat first so you preserve useful context. Keep it terse markdown — bullets, short headings, concrete items. Don't narrate that you updated it unless the user asks.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Full new markdown body of the heartbeat. Replaces existing content.",
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "read_user_profile",
    description:
      "Read the calling user's persona profile (markdown) — language, tone, verbosity, communication style, and behavioural rules tailored to this specific user. The profile is already injected into your system prompt; reach for this tool only when you need to see the exact text before updating it via update_user_profile.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "update_user_profile",
    description:
      "Overwrite the calling user's persona profile markdown. Use to record durable preferences the user expresses across conversations — language they want replies in, tone, verbosity, things to avoid, recurring context. Read the current profile first and merge — this REPLACES the file. Keep the existing structure (Language / Tone / Verbosity / Role headers, then Communication style / Context / Instructions sections). Don't narrate the update aloud.",
    inputSchema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Full new markdown body of the profile. Replaces existing content. Max 16000 chars.",
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    name: "list_brain_files",
    description:
      "Discover what's actually in the brain markdown tree at the structured-memory root. Returns one entry per file or directory with relPath, size, modified mtime, and isDirectory. Pass an optional subdir (e.g. 'users/santi') to scope the listing, and recursive:true to walk the whole subtree. Use before write_brain_file when you're not sure where a fact belongs, and to confirm whether today's daily log already exists.",
    inputSchema: {
      type: "object",
      properties: {
        subdir: {
          type: "string",
          description:
            "Optional subdirectory under the brain root (forward slashes ok). Empty / omitted = list the root.",
        },
        recursive: {
          type: "boolean",
          description: "When true, walk the subtree. Default false (one level only).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_brain_file",
    description:
      "Read a brain markdown file by relative path (e.g. 'brain.md', 'users/santi/profile.md', 'daily/2026-05-01.md'). Returns relPath + size + truncated flag + content. The first 256 KB are returned verbatim; longer files are truncated with truncated:true. Use before write_brain_file so you preserve existing content (read-modify-write).",
    inputSchema: {
      type: "object",
      properties: {
        rel_path: {
          type: "string",
          description: "Path relative to the brain root, forward slashes ok.",
        },
      },
      required: ["rel_path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_brain_file",
    description:
      "Write a brain markdown file directly. Two modes:\n" +
      "  1. Whole-file write — pass `content` to replace the file body. Creates parent directories and the file itself if missing (use this for new daily logs).\n" +
      "  2. Targeted patch — pass `find` (substring or regex when isRegex=true) plus `replacement` to swap a specific section in place. The find substring must be unique in the file; ambiguity errors out so you don't accidentally edit the wrong block.\n\n" +
      "Always read_brain_file first so you don't blow away existing content. Only .md files are writable. Path must stay inside the brain root (no '..', no absolute paths).\n\n" +
      "Use this in place of creating a remark tagged 'brain' — you can land facts in the right markdown file (decisions.md, lessons.md, projects.md, the user's daily log, etc.) directly during a phone-driven session.",
    inputSchema: {
      type: "object",
      properties: {
        rel_path: {
          type: "string",
          description: "Path relative to the brain root, must end in .md.",
        },
        content: {
          type: "string",
          description: "Whole-file mode: full new file body. Mutually exclusive with find/replacement.",
        },
        find: {
          type: "string",
          description: "Patch mode: substring (or regex if isRegex=true) to find. Must be unique in the file.",
        },
        isRegex: {
          type: "boolean",
          description: "Treat `find` as a regex (multiline mode). Default false.",
        },
        replacement: {
          type: "string",
          description: "Patch mode: text that replaces the matched section.",
        },
      },
      required: ["rel_path"],
      additionalProperties: false,
    },
  },
  {
    name: "youtube_search",
    description:
      "Search YouTube for videos matching a free-text query. Returns up to 5 results with id, title, channel, duration (seconds), and thumbnail URL. Use this to find a video the user can play as thinking-time filler — e.g. 'lo-fi beats 1 hour', 'Al Jazeera live Gaza', 'Rick Beato new song review'. This does NOT start playback; pass the chosen `id` to `youtube_play` to do that.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search query. Up to 200 chars.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "youtube_play",
    description:
      "Start playing a YouTube video as thinking-time filler on the dashboard. Switches the filler mode to 'youtube' so the selection takes effect. The video plays whenever Claude is thinking and pauses (with a smooth fade) when the assistant reply arrives; the next thinking window resumes from the same position. Pass one of: a raw `video_id` (11-char id), a full YouTube URL in `url`, or a free-text `query` — if only a query is given, this tool internally searches YouTube and picks the top result. Optional `title` / `duration_sec` / `thumbnail_url` override or pre-fill the display fields.",
    inputSchema: {
      type: "object",
      properties: {
        video_id: {
          type: "string",
          description: "YouTube video id (the 11-char string from the URL, e.g. 'dQw4w9WgXcQ').",
        },
        url: {
          type: "string",
          description: "Full YouTube URL — youtube.com/watch?v=..., youtu.be/..., or youtube.com/shorts/...",
        },
        query: {
          type: "string",
          description: "Free-text search query — tool will pick the first result.",
        },
        title: { type: "string", description: "Optional human-readable title." },
        duration_sec: {
          type: "integer",
          description: "Optional duration in seconds (for status/UI; playback works without it).",
        },
        thumbnail_url: {
          type: "string",
          description: "Optional thumbnail URL for status display.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "youtube_enqueue",
    description:
      "Append a YouTube video to the play queue without interrupting what's currently playing. If nothing is selected yet, the first enqueued track is promoted straight into now-playing (so 'queue this' on an empty queue behaves like 'play this'). Same arg shape as youtube_play — pass one of: a raw `video_id`, a full YouTube URL in `url`, or a free-text `query`. Use when the user says 'queue up...', 'add this next', 'after this play...'.",
    inputSchema: {
      type: "object",
      properties: {
        video_id: {
          type: "string",
          description: "YouTube video id (the 11-char string from the URL).",
        },
        url: {
          type: "string",
          description: "Full YouTube URL.",
        },
        query: {
          type: "string",
          description: "Free-text search query — tool will pick the first result.",
        },
        title: { type: "string", description: "Optional human-readable title." },
        duration_sec: {
          type: "integer",
          description: "Optional duration in seconds.",
        },
        thumbnail_url: {
          type: "string",
          description: "Optional thumbnail URL.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "filler_set_mode",
    description:
      "Change what plays during the assistant's thinking gaps and persist it (telegram-voice/filler-config.json — survives reloads, the dashboard and Telegram Python worker both pick it up).\n\nModes:\n- 'news' — Middle East & world headlines (pre-rendered clips). url_or_topic narrows the pool ('AI safety', 'tech').\n- 'fun-facts' — curated trivia spoken via dashboard TTS. url_or_topic is an optional topic hint ('space', 'history').\n- 'calendar' — upcoming items from the heartbeat / agenda spoken via TTS. url_or_topic is an optional range hint ('today', 'this week').\n- 'youtube' — the currently-selected video plays on the dashboard. url_or_topic can be a YouTube URL the user named — but you still have to call youtube_play to actually load it; this just records the preference.\n- 'quiet' — no spoken content, ambient windchime only. (Preferred user-facing label.)\n- 'hum' — legacy alias of 'quiet'.\n\nTo silence the assistant entirely (no replies spoken at all), the user toggles the speaker button in the media drawer — that is a separate per-client TTS mute, not a filler mode. Don't try to do that via this tool; the dashboard collapses any legacy 'off' value to 'quiet'.\n\nCall when the user asks to switch ('play fun facts', 'just the calendar', 'silence please', 'news about AI', etc.). Use filler_get_mode first if you need to know what's currently set before changing.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [
            "news",
            "fun-facts",
            "calendar",
            "youtube",
            "quiet",
            "hum",
          ],
          description:
            "The filler mode to switch to. See tool description for what each one plays.",
        },
        url_or_topic: {
          type: "string",
          description:
            "Optional mode-specific hint. For 'news' / 'fun-facts' / 'calendar' a topic or range hint; for 'youtube' a video URL the user mentioned. Ignored for 'quiet' / 'hum'. Omit if the user didn't specify one.",
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "filler_get_mode",
    description:
      "Report the persisted filler setting plus what would actually play right now. Returns: mode (the saved choice), url_or_topic (the saved hint, if any), active_source (what the browser would resolve to given current state — e.g. 'youtube' falls back to 'news' when no video is selected), and youtube_selection details when a video is loaded. Use when the user asks 'what's playing?' / 'what's the filler set to?', or before filler_set_mode so you know what you're changing FROM.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "youtube_stop",
    description:
      "Stop YouTube filler and clear the selection. After this the dashboard falls back to the normal TTS news-clip filler during thinking. Use when the user says 'stop the music', 'back to news', or explicitly asks to end playback. (To pause without losing the selection, call youtube_play again later with the same id — resume is automatic.)",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "youtube_status",
    description:
      "Report what YouTube filler is currently doing: selected video (if any), server's intent (playing|paused|idle), last-known playback position in seconds, and whether the position report is stale (no browser update in the last 5 s). Use when the user asks 'what's playing?' or when you want to confirm that a recent youtube_play call actually landed on the dashboard.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "autopilot_status",
    description:
      "Check whether autopilot is currently enabled and read the current strategic directive (the user's north star that shapes every autonomous decision). Read-only — does not toggle anything. Returns { enabled: boolean, directive: string } where `directive` is empty string when none has been set. Use when the user asks 'is autopilot on?' / 'what's the directive?' before deciding whether to flip it via control_dashboard's toggle_autopilot or set_directive.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  // ---- Chat -------------------------------------------------------------
  {
    name: "list_channels",
    description:
      "List every chat channel the user can see — the global 'general' room, every project channel they have access to, and any DMs they're in. Each entry includes id, kind ('general'|'project'|'dm'), display name, projectId (project channels only), peer (DMs only), createdAt, and unread count from the user's last-seen timestamp. Use when the user asks 'what's new in chat' / 'any new messages' / 'who's pinged me' so you can prioritise channels with unread > 0.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_messages",
    description:
      "Read messages from a chat channel. Returns up to `limit` (default 20, max 100) most-recent messages in chronological order (oldest first), each with id, userId, userName, kind ('text'|'ai_session'|'system'), body, meta, createdAt. To page back through history, pass `before` = the id of the earliest message you saw and call again. `hasMore` and `nextBefore` in the response let you decide whether to keep paging. Requires that the user can access the channel (project channels gated on project access, DMs gated on membership).",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "integer", description: "Numeric channel id from list_channels." },
        limit: { type: "integer", description: "Max messages to return (default 20, max 100)." },
        before: {
          type: "integer",
          description:
            "Optional cursor — if provided, only messages with id < before are returned. Use the `nextBefore` from a previous response to walk further back.",
        },
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Post a text message to a chat channel as the current user. Pushes a notification to the channel's recipients (everyone in 'general', project members in project channels, the peer in a DM) and broadcasts over the live WebSocket so open clients see it instantly. Use when the user explicitly asks you to send a message — describe what you'll post in plain prose first and only fire after they confirm. No attachments or AI-session kinds; plain text only, max 10 000 chars.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "integer", description: "Numeric channel id." },
        text: {
          type: "string",
          description: "Message body. Plain text, up to 10 000 chars.",
        },
      },
      required: ["channel_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "create_dm",
    description:
      "Open a direct-message channel with another dashboard user (or return the existing one if you already have one). Returns { channelId, peer: { id, name } } so you can immediately follow up with send_message. The user must exist and not be the current user. Use when the user says 'message Sander', 'DM the team lead', etc.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: {
          type: "integer",
          description: "Target user's numeric id (from list_users).",
        },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
  },
  // ---- Project actions --------------------------------------------------
  {
    name: "deploy_project",
    description:
      "Stage all changes in a project, commit them with the given message (or a default 'Deploy from spar @ <iso>'), and push to origin. Vercel-connected repos auto-deploy on push, so a successful return = deploy triggered. Admin-only: pushing to a public remote is a destructive shared-state action. Fails if the working tree has unresolved conflicts, no remote, or no branch. Always describe what you'll deploy aloud and get an explicit yes before firing.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id, e.g. 'neva17'." },
        message: {
          type: "string",
          description:
            "Optional commit message (max 500 chars). Defaults to 'Deploy from spar @ <iso-timestamp>'.",
        },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "start_terminal",
    description:
      "Spawn a Claude Code PTY for the project if one isn't running already. Idempotent — returns the existing session if it's already up (alreadyRunning=true). Use when the user wants to start working on a project that has no live terminal, or when dispatch_to_project failed because no session exists yet.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_terminal",
    description:
      "Kill the running Claude Code PTY for a project. Use when the user explicitly asks to stop, restart, or free up a project's terminal. Returns { stopped, running } — `stopped:false` means no PTY was running.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_project",
    description:
      "Register a new project in the dashboard. Creates the directory on disk if no path is specified. Admin only. Use when the user wants to start a new project — saves manual config editing.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique project id (lowercase, digits, dashes). e.g. 'superskunk'",
        },
        name: {
          type: "string",
          description: "Display name for the project. e.g. 'SUPERSKUNK Coffeeshop'",
        },
        path: {
          type: "string",
          description:
            "Absolute filesystem path. If omitted, auto-creates under the projects root.",
        },
        visibility: {
          type: "string",
          enum: ["team", "client", "public"],
          description: "Access level. Default: team",
        },
        sub_path: {
          type: "string",
          description: "Optional subfolder scope within path",
        },
        preview_url: { type: "string", description: "Public preview URL" },
        live_url: { type: "string", description: "Production URL" },
        dev_port: { type: "integer", description: "Local dev server port" },
        dev_command: { type: "string", description: "Custom dev startup command" },
        deploy_branch: { type: "string", description: "Git branch to deploy from" },
      },
      required: ["id", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_project",
    description:
      "Remove a project from the dashboard config. Does NOT delete files from disk — only unregisters it. Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id to remove" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  // ---- Admin ------------------------------------------------------------
  {
    name: "list_users",
    description:
      "List every dashboard user with id, email, name, role ('admin'|'team'|'client'), createdAt, and project access list. Admin-only — mirrors /api/admin/users. Use when the user asks 'who's on the dashboard', 'who has access to project X', or before create_dm so you can resolve a name to an id.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_presence",
    description:
      "List currently-online users — anyone with a tab heartbeat in the last 90 s. Each entry includes liveSessions (tab count), oldestConnectedAt, latestSeenAt, and a per-tab breakdown with current path. Super-user-only (matches /api/admin/activity). Use when the user asks 'who's online', 'is anyone in the app', or 'what is X looking at right now'.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_activity",
    description:
      "Recent user-activity feed — page visits and recorded actions (calls started, dispatches fired, deploys run, etc), newest first. Super-user-only. Use when the user asks 'what's been happening on the dashboard' or wants a recent-action audit.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "How many entries (default 50, max 500).",
        },
      },
      additionalProperties: false,
    },
  },
  // ---- Recordings -------------------------------------------------------
  {
    name: "list_recordings",
    description:
      "List the user's recent browser-recording sessions (newest first), plus the active session if one is running. Each entry includes id, status ('active'|'ended'), startedAt, endedAt, eventCount, and any attached automation. Use when the user asks 'what did I record yesterday' or before stop_recording to find the active session id.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "How many sessions to return (default 20, max 100).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_recording",
    description:
      "Allocate a new recording session for the current user. Returns the session row; the actual headless Chromium capturing events is launched on demand by the browser viewer. Use when the user says 'start recording' / 'capture this flow'.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "stop_recording",
    description:
      "End an active recording session and tear down its headless Chromium if one is running. Returns the updated session row.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session id from list_recordings or start_recording (UUID).",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  // ---- Telegram voice ---------------------------------------------------
  {
    name: "telegram_status",
    description:
      "Report the Telegram voice bridge state — call state ('idle'|'dialing'|'ringing'|'connected'|'hanging_up'|'starting'), peer phone, started_at, last_event, last_error. Returns {state:'offline'} if the Python service isn't running. Use to check whether a Telegram leg is active before deciding to call/hang up.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "telegram_call",
    description:
      "Initiate a Telegram voice call to either a phone number or a Telegram user_id. Admin-only. With no args, calls the default TARGET_PHONE configured on the Python service. Always describe who you're calling aloud and get a verbal yes first — this rings a real phone.",
    inputSchema: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description:
            "Phone number in international format (e.g. '+31612345678'). Optional — falls back to the service default.",
        },
        user_id: {
          type: "integer",
          description: "Telegram user id to call instead of a phone.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "telegram_hangup",
    description:
      "End the current Telegram call (no-op if not connected). Admin-only. Use when the user says 'hang up', 'end the call', or after the conversation has clearly wrapped.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "telegram_speak",
    description:
      "Synthesize text via Kokoro and play it through the active Telegram call so the person on the other end hears it. Admin-only. Use only while the call is connected — if state isn't 'connected', call telegram_status first to confirm. Plain prose only, max 4000 chars.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to say aloud. Plain prose." },
        voice: { type: "string", description: "Optional Kokoro voice id." },
        speed: {
          type: "number",
          description: "Optional speech speed (1.0 = normal).",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  // ---- Automations ------------------------------------------------------
  {
    name: "list_automations",
    description:
      "List every saved automation with its run stats (lastRunAt, runCount, failedRuns, clarificationsNeeded). Today's automations are URL-kind — a saved navigation target paired with optional description. Use when the user asks 'what automations do I have' or before update_automation.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_automation",
    description:
      "Create a new URL-kind automation. `name` is the user-facing label; `url` (or the alias `action`) is what the recorded flow navigates to; `description` (or the alias `trigger`) is an optional one-line note. Returns the new row with empty stats.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name for the automation (max 200 chars).",
        },
        url: {
          type: "string",
          description: "Target URL. Alias: `action`.",
        },
        action: {
          type: "string",
          description: "Alias for `url` — the navigation target.",
        },
        trigger: {
          type: "string",
          description:
            "Alias for `description` — a free-form note describing when to run it.",
        },
        description: {
          type: "string",
          description: "Optional human-readable description.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "update_automation",
    description:
      "Patch an existing automation. Pass any subset of name / description / url / enabled — omitted fields stay unchanged. `action`/`trigger` are accepted as aliases for url/description. Returns the updated row with current stats.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Automation id." },
        name: { type: "string", description: "New display name." },
        description: {
          type: "string",
          description: "New description (empty string clears it).",
        },
        url: { type: "string", description: "New target URL." },
        action: { type: "string", description: "Alias for `url`." },
        trigger: { type: "string", description: "Alias for `description`." },
        enabled: {
          type: "boolean",
          description: "Toggle the automation on/off.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  // ---- Utility ----------------------------------------------------------
  {
    name: "companion_status",
    description:
      "Report whether the user's companion app (the desktop bridge that keeps a Chromium browser session synced to the dashboard) is currently connected. Returns { connected: boolean }.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "send_push",
    description:
      "Send a Web-Push notification to the current user's own subscribed devices (phone, desktop, etc). Useful for nudges that should survive the dashboard tab being closed. Title + body required, optional deep-link URL inside the app. Only fans out to the calling user — can't ping arbitrary users.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title (max 200 chars)." },
        body: { type: "string", description: "Notification body (max 1000 chars)." },
        url: {
          type: "string",
          description:
            "Optional in-app deep link the notification opens on click (e.g. '/projects/foo').",
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "dashboard_control",
    description:
      "Drive the dashboard UI for the current user. Lets you flip autopilot, open or close the left/right sidebars, start a fresh conversation, or set the autopilot directive remotely — anything the user could click, you can trigger here. The change appears instantly on whatever tab the user has open and persists server-side for autopilot/directive actions. Use sparingly: the user should rarely need to flip these themselves once you've established a directive.\n\n" +
      "Actions:\n" +
      "  • toggle_autopilot — pass `value: true|false`. Enables/disables the autonomous loop. Persisted in autopilot_users.\n" +
      "  • open_sidebar / close_sidebar — pass `side: \"left\"|\"right\"`. Left = conversations / threads. Right = autopilot panel.\n" +
      "  • new_conversation — start a brand-new spar thread. Clears the local transcript on the user's tab.\n" +
      "  • set_directive — pass `value: string` (the strategic north star, max 2000 chars). Persisted in autopilot_users.directive and picked up on the next dispatch completion.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "toggle_autopilot",
            "open_sidebar",
            "close_sidebar",
            "new_conversation",
            "set_directive",
          ],
          description: "Which UI action to perform.",
        },
        value: {
          description:
            "Action-dependent payload. boolean for toggle_autopilot, string for set_directive, omit for sidebar / new_conversation actions.",
        },
        side: {
          type: "string",
          enum: ["left", "right"],
          description:
            "For open_sidebar / close_sidebar — which sidebar to target.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "speak_tts",
    description:
      "Synthesize text via the local Kokoro sidecar (the dashboard's TTS engine). Returns synthesised byte count. Note: the audio bytes don't currently auto-play in the browser via this tool — synthesis runs server-side and primes Kokoro's caches. For audible playback, prefer letting your conversational reply ride the normal TTS reply path; reach for this tool when the user explicitly wants you to pre-warm or test the voice pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to synthesize. Plain prose, max 4000 chars." },
        voice: { type: "string", description: "Optional Kokoro voice id." },
        speed: {
          type: "number",
          description: "Optional speech speed (1.0 = normal).",
        },
        lang: { type: "string", description: "Optional language hint, e.g. 'en'." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args, _attempt = 1) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [500, 1500, 3000];
  let res;
  try {
    res = await fetch(`${DASHBOARD_URL}/api/internal/spar-tools`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ tool: name, args: args || {} }),
    });
  } catch (err) {
    if (_attempt < MAX_RETRIES) {
      process.stderr.write(`[spar-mcp] fetch failed (attempt ${_attempt}/${MAX_RETRIES}), retrying: ${String(err).slice(0, 120)}\n`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[_attempt - 1]));
      return callTool(name, args, _attempt + 1);
    }
    throw new Error(`network error after ${MAX_RETRIES} attempts: ${String(err).slice(0, 120)}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (_attempt < MAX_RETRIES) {
      process.stderr.write(`[spar-mcp] non-JSON response (${res.status}, attempt ${_attempt}/${MAX_RETRIES}), retrying\n`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[_attempt - 1]));
      return callTool(name, args, _attempt + 1);
    }
    throw new Error(`dashboard returned non-JSON after ${MAX_RETRIES} attempts (${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status >= 500 && _attempt < MAX_RETRIES) {
    process.stderr.write(`[spar-mcp] server error ${res.status} (attempt ${_attempt}/${MAX_RETRIES}), retrying\n`);
    await new Promise((r) => setTimeout(r, RETRY_DELAYS[_attempt - 1]));
    return callTool(name, args, _attempt + 1);
  }
  if (!res.ok || !json.ok) {
    throw new Error(json && json.error ? json.error : `dashboard returned ${res.status}`);
  }
  return json.result;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "amaso-spar", version: "1.0.0" },
    });
    return;
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
    // notifications carry no id and expect no reply
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      reply(id, {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
      return;
    }
    try {
      const result = await callTool(name, args);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      reply(id, { content: [{ type: "text", text }] });
    } catch (err) {
      reply(id, {
        content: [{ type: "text", text: `Error: ${err && err.message ? err.message : String(err)}` }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) {
    replyError(id, -32601, `Unknown method: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg).catch((err) => {
    process.stderr.write(`[spar-mcp] handle error: ${err && err.stack ? err.stack : String(err)}\n`);
  });
});
rl.on("close", () => process.exit(0));
