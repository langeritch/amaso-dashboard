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
      "Change what plays during the assistant's thinking gaps and persist it (telegram-voice/filler-config.json — survives reloads, the dashboard and Telegram Python worker both pick it up).\n\nModes:\n- 'news' — Middle East & world headlines (pre-rendered clips). url_or_topic narrows the pool ('AI safety', 'tech').\n- 'fun-facts' — curated trivia spoken via dashboard TTS. url_or_topic is an optional topic hint ('space', 'history').\n- 'calendar' — upcoming items from the heartbeat / agenda spoken via TTS. url_or_topic is an optional range hint ('today', 'this week').\n- 'youtube' — the currently-selected video plays on the dashboard. url_or_topic can be a YouTube URL the user named — but you still have to call youtube_play to actually load it; this just records the preference.\n- 'quiet' — no spoken content, ambient windchime only. (Preferred user-facing label.)\n- 'hum' — legacy alias of 'quiet'.\n- 'off' — fully silent, not even the windchime.\n\nCall when the user asks to switch ('play fun facts', 'just the calendar', 'turn it off', 'silence please', 'news about AI', etc.). Use filler_get_mode first if you need to know what's currently set before changing.",
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
            "off",
          ],
          description:
            "The filler mode to switch to. See tool description for what each one plays.",
        },
        url_or_topic: {
          type: "string",
          description:
            "Optional mode-specific hint. For 'news' / 'fun-facts' / 'calendar' a topic or range hint; for 'youtube' a video URL the user mentioned. Ignored for 'quiet' / 'hum' / 'off'. Omit if the user didn't specify one.",
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
];

async function callTool(name, args) {
  const res = await fetch(`${DASHBOARD_URL}/api/internal/spar-tools`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ tool: name, args: args || {} }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`dashboard returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
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
