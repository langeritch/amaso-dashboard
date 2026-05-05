/**
 * Translate raw MCP tool names + inputs into the human-friendly
 * labels the spar chat UI shows for each step of the agentic loop.
 *
 * Tool names look like `mcp__spar__read_terminal_scrollback` over the
 * wire. The UI never wants to surface the prefix or the snake_case —
 * those are machinery the user doesn't need to see.
 *
 * One module so the API route, any future log viewer, and the UI all
 * agree on what "Reading terminal output for badkamerstijl" looks
 * like for a given tool call.
 */

export interface SparToolLabel {
  /** Verb-noun phrase for the action ("Reading terminal output"). */
  label: string;
  /** Optional context string ("for badkamerstijl") — already prefixed
   *  with the appropriate preposition. Empty when no input is useful. */
  detail: string;
}

const SPAR_PREFIX = "mcp__spar__";

function shortName(raw: string): string {
  return raw.startsWith(SPAR_PREFIX) ? raw.slice(SPAR_PREFIX.length) : raw;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function pickString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

interface LabelDef {
  /** Action phrase. */
  verb: string;
  /** Build the trailing context fragment from the tool input. Return
   *  "" when there's nothing useful (e.g. no project_id given). */
  detail?: (input: Record<string, unknown>) => string;
}

const LABELS: Record<string, LabelDef> = {
  list_projects: { verb: "Listing projects" },
  describe_project: {
    verb: "Looking at project",
    detail: (i) => detailForProject(i),
  },
  read_heartbeat: { verb: "Reading the heartbeat" },
  read_terminal_scrollback: {
    verb: "Reading terminal output",
    detail: (i) => detailForProject(i),
  },
  list_recent_file_changes: {
    verb: "Checking recent file changes",
    detail: (i) => detailForProject(i),
  },
  list_recent_remarks: {
    verb: "Reading remarks",
    detail: (i) => {
      const project = pickString(i, "project_id");
      const tag = pickString(i, "tag");
      if (project && tag) return `for ${project} tagged ${tag}`;
      if (project) return `for ${project}`;
      if (tag) return `tagged ${tag}`;
      return "";
    },
  },
  create_remark: {
    verb: "Capturing a remark",
    detail: (i) => {
      const body = pickString(i, "body");
      return body ? `— ${truncate(body, 60)}` : "";
    },
  },
  edit_remark: { verb: "Editing a remark" },
  resolve_remark: { verb: "Resolving a remark" },
  unresolve_remark: { verb: "Reopening a remark" },
  delete_remark: { verb: "Deleting a remark" },
  read_project_file: {
    verb: "Reading file",
    detail: (i) => {
      const project = pickString(i, "project_id");
      const file = pickString(i, "relative_path") || pickString(i, "path");
      if (project && file) return `${file} in ${project}`;
      if (file) return file;
      if (project) return `in ${project}`;
      return "";
    },
  },
  dispatch_to_project: {
    verb: "Dispatching to project",
    detail: (i) => detailForProject(i),
  },
  send_keys_to_project: {
    verb: "Sending keys to project",
    detail: (i) => detailForProject(i),
  },
  update_heartbeat: { verb: "Updating the heartbeat" },
  read_user_profile: { verb: "Reading user profile" },
  update_user_profile: { verb: "Updating user profile" },
  read_graph: { verb: "Reading the knowledge graph" },
  write_graph: { verb: "Updating the knowledge graph" },
  list_channels: { verb: "Listing chat channels" },
  read_messages: {
    verb: "Reading chat messages",
    detail: (i) => {
      const ch = pickString(i, "channel_id");
      return ch ? `in ${ch}` : "";
    },
  },
  send_message: {
    verb: "Sending chat message",
    detail: (i) => {
      const ch = pickString(i, "channel_id");
      return ch ? `to ${ch}` : "";
    },
  },
  create_dm: {
    verb: "Opening a DM",
    detail: (i) => {
      const target = pickString(i, "user_email") || pickString(i, "user_id");
      return target ? `with ${target}` : "";
    },
  },
  deploy_project: {
    verb: "Deploying project",
    detail: (i) => detailForProject(i),
  },
  start_terminal: {
    verb: "Starting terminal",
    detail: (i) => detailForProject(i),
  },
  stop_terminal: {
    verb: "Stopping terminal",
    detail: (i) => detailForProject(i),
  },
  create_project: {
    verb: "Creating a project",
    detail: (i) => {
      const id = pickString(i, "project_id") || pickString(i, "id");
      return id ? `— ${id}` : "";
    },
  },
  delete_project: {
    verb: "Deleting project",
    detail: (i) => detailForProject(i),
  },
  list_users: { verb: "Listing users" },
  get_presence: { verb: "Checking who's online" },
  get_activity: { verb: "Checking recent activity" },
  list_recordings: { verb: "Listing recordings" },
  start_recording: { verb: "Starting recording" },
  stop_recording: { verb: "Stopping recording" },
  telegram_status: { verb: "Checking Telegram status" },
  telegram_call: { verb: "Placing a Telegram call" },
  telegram_hangup: { verb: "Hanging up Telegram" },
  telegram_speak: { verb: "Speaking through Telegram" },
  list_automations: { verb: "Listing automations" },
  create_automation: { verb: "Creating an automation" },
  update_automation: { verb: "Updating an automation" },
  companion_status: { verb: "Checking companion status" },
  send_push: { verb: "Sending push notification" },
  speak_tts: { verb: "Speaking out loud" },
};

function detailForProject(input: Record<string, unknown>): string {
  const id = pickString(input, "project_id");
  return id ? `for ${id}` : "";
}

function truncate(s: string, n: number): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  return trimmed.length <= n ? trimmed : trimmed.slice(0, n - 1) + "…";
}

export function labelForToolUse(name: string, input: unknown): SparToolLabel {
  const short = shortName(name);
  const def = LABELS[short];
  const rec = asRecord(input);
  if (!def) {
    // Unknown tool — humanise the snake_case so we still surface
    // *something* helpful instead of the raw symbol.
    return {
      label: short.replace(/_/g, " "),
      detail: "",
    };
  }
  return {
    label: def.verb,
    detail: def.detail?.(rec) ?? "",
  };
}

/** Sources baked into every spar turn before the model has even
 *  thought. CLAUDE.md and MEMORY.md ride along via the CLI's working-
 *  directory autoload; heartbeat / user-profile / hard-won-solutions
 *  (the matched skills block) are stitched in by the route. The UI
 *  surfaces this list as the "sources read" baseline so the user can
 *  see what context was guaranteed available. */
export const BASELINE_SPAR_SOURCES: readonly string[] = [
  "CLAUDE.md",
  "MEMORY.md",
  "heartbeat",
  "user profile",
  "hard-won solutions",
];

/** Map a tool_use event onto a human-readable source label, or null
 *  when the tool isn't really "reading a source" (writes, dispatches,
 *  action-only tools — those don't belong in a transparency list of
 *  what was consulted to build the answer). The label is short,
 *  lowercased prose — it sits in a chip next to the assistant message
 *  and is meant to be scannable, not technical. */
export function sourceForToolUse(name: string, input: unknown): string | null {
  const short = shortName(name);
  const rec = asRecord(input);
  switch (short) {
    case "read_graph":
      return "knowledge graph";
    case "read_heartbeat":
      return "heartbeat";
    case "read_user_profile":
      return "user profile";
    case "list_recent_remarks": {
      const project = pickString(rec, "project_id");
      const tag = pickString(rec, "tag");
      if (project && tag) return `remarks: ${project} / ${tag}`;
      if (project) return `remarks: ${project}`;
      if (tag) return `remarks: ${tag}`;
      return "remarks";
    }
    case "read_terminal_scrollback": {
      const project = pickString(rec, "project_id");
      return project ? `terminal: ${project}` : "terminal";
    }
    case "list_recent_file_changes": {
      const project = pickString(rec, "project_id");
      return project ? `file changes: ${project}` : "file changes";
    }
    case "read_project_file": {
      const project = pickString(rec, "project_id");
      const file = pickString(rec, "relative_path") || pickString(rec, "path");
      if (project && file) return `file: ${project}/${file}`;
      if (file) return `file: ${file}`;
      if (project) return `file: ${project}`;
      return "file";
    }
    case "list_projects":
    case "describe_project":
      return "projects";
    case "read_messages": {
      const ch = pickString(rec, "channel_id");
      return ch ? `messages: ${ch}` : "messages";
    }
    case "list_channels":
      return "channels";
    case "list_users":
      return "users";
    case "get_presence":
      return "presence";
    case "get_activity":
      return "activity";
    case "list_recordings":
      return "recordings";
    case "list_automations":
      return "automations";
    case "telegram_status":
      return "telegram status";
    case "companion_status":
      return "companion status";
    default: {
      // Read-shape fallback: anything that starts read_ / list_ / get_
      // / describe_ is consulting a source even if we don't have a hand-
      // crafted label. Action verbs (create, update, delete, dispatch,
      // send, deploy, start, stop, write, edit, resolve, hangup, speak)
      // are excluded — those are doing things, not reading.
      if (
        short.startsWith("read_") ||
        short.startsWith("list_") ||
        short.startsWith("get_") ||
        short.startsWith("describe_")
      ) {
        return short.replace(/_/g, " ");
      }
      return null;
    }
  }
}

/** Produce a one-line summary of a tool result for the UI. The full
 *  payload sits behind a click-to-expand; this is the always-visible
 *  blurb. */
export function summariseToolResult(content: string, ok: boolean): string {
  if (!ok) {
    const first = content.split("\n").find((l) => l.trim().length > 0) ?? "";
    return first ? `failed — ${truncate(first, 80)}` : "failed";
  }
  // Try to read structured success markers first — most spar tools
  // return JSON-shaped strings via the MCP server's content blocks.
  const trimmed = content.trim();
  if (!trimmed) return "done";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.summary === "string" && obj.summary.trim()) {
          return truncate(obj.summary, 100);
        }
        if (Array.isArray(parsed)) {
          return `${parsed.length} ${parsed.length === 1 ? "item" : "items"}`;
        }
        const keys = Object.keys(obj);
        if (keys.length === 0) return "done";
        return `${keys.length} ${keys.length === 1 ? "field" : "fields"}`;
      }
    } catch {
      /* fall through to text-based summary */
    }
  }
  const firstLine = trimmed.split("\n").find((l) => l.trim().length > 0) ?? "";
  return truncate(firstLine, 100);
}
