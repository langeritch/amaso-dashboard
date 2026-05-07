#!/usr/bin/env node
// Stdio MCP server the Claude CLI spawns when the spar route runs in
// "extension driver" mode. Mirrors the wire shape of @playwright/mcp's
// browser_* tools so spar prompts written for Playwright keep working.
//
// Each tool call HTTP-POSTs to /api/internal/ext-tools on the dashboard
// with a bearer token (minted per spar invocation, same as the regular
// spar-mcp-server). The dashboard route forwards the call to the
// user's connected browser extension over the ext-bridge WebSocket and
// returns the ack.
//
// Tool descriptions intentionally match Playwright's so the model
// transfers its existing intuition. Where we differ (we accept both
// `selector` and `ref`; some tools take a `submit:true` shortcut), the
// description spells it out.

import readline from "node:readline";
import process from "node:process";

const TOKEN = process.env.AMASO_SPAR_TOKEN;
const DASHBOARD_URL =
  process.env.AMASO_DASHBOARD_URL || "http://127.0.0.1:3737";

if (!TOKEN) {
  process.stderr.write("[ext-mcp] AMASO_SPAR_TOKEN required\n");
  process.exit(1);
}

const targetSchema = {
  ref: {
    type: "string",
    description:
      "Element reference from the most recent browser_snapshot output (e.g. 'ref_12'). Use this when you've just snapshotted; survives reflow.",
  },
  selector: {
    type: "string",
    description:
      "CSS selector for the element. Use when you know the page structure or no recent snapshot is available.",
  },
};

const TOOLS = [
  {
    name: "browser_navigate",
    description:
      "Navigate the driver tab to a URL. Replaces whatever was there. Waits up to 30 s for load to complete before returning. Resets the snapshot ref map.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to load." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate_back",
    description: "Go back one step in the driver tab's history.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element by ref or selector. Dispatches real mouse events at the element's centre (so site JS that listens for mousedown/up sees them). Optional button: 'left'|'right'|'middle' (default left), and doubleClick:true for a double click.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetSchema,
        button: { type: "string", enum: ["left", "right", "middle"] },
        doubleClick: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into a focused input. Supply ref or selector to target. Set clear:true to wipe the field first. Set submit:true (or pressEnter:true) to press Enter after typing — useful for search bars / login forms.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetSchema,
        text: { type: "string", description: "Text to insert." },
        clear: { type: "boolean", description: "Clear existing value first." },
        submit: {
          type: "boolean",
          description: "Press Enter after typing.",
        },
        pressEnter: { type: "boolean", description: "Alias of submit." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press_key",
    description:
      "Press a single key on whatever element has focus. Supported names: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, plus any single printable character.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name." },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_take_screenshot",
    description:
      "Capture a screenshot of the driver tab. Returns base64 PNG by default; pass format:'jpeg' for a smaller payload, fullPage:true to capture beyond the viewport.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"] },
        fullPage: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Snapshot the page's accessibility tree as YAML-ish text. Each interactable node gets a stable [ref_N] you can quote in subsequent browser_click / browser_type / browser_hover calls. Prefer refs over selectors when you've just snapshotted — they survive reflow.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description:
      "Wait for a condition. Pass exactly one of: selector (wait until present), text (wait until text appears in body), textGone (wait until text disappears), or just `time` for a plain delay (ms). Defaults: time=5000, max 60000.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        textGone: { type: "string" },
        time: { type: "integer", description: "Max wait in ms (1000–60000)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description:
      "Move the mouse to an element's centre (no click). Useful for revealing hover-only menus.",
    inputSchema: {
      type: "object",
      properties: { ...targetSchema },
      additionalProperties: false,
    },
  },
  {
    name: "browser_select_option",
    description:
      "Select one or more options on a <select>. Accepts either values:['a','b'] or a single value:'a'. Matches against option.value first, then option.text.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetSchema,
        values: { type: "array", items: { type: "string" } },
        value: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill_form",
    description:
      "Fill multiple fields in one call. Each entry needs ref or selector and a value. Clears the existing value first; does not submit the form (call browser_click on the submit button after).",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ...targetSchema,
              value: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
      required: ["fields"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tabs",
    description:
      "Manage browser tabs. Actions:\n  - 'list' (default): list all tabs across windows, marking the driver target.\n  - 'select': switch the driver target (and activate the tab) — pass {action:'select', id}.\n  - 'new': open a new tab and make it the driver target — pass {action:'new', url?}.\n  - 'close': close a tab — pass {action:'close', id?} (closes driver tab if id omitted).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "select", "new", "close"],
        },
        id: { type: "integer" },
        url: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description: "Close the driver tab.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_resize",
    description:
      "Resize the window holding the driver tab. Pass width and height in pixels.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["width", "height"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Run a JavaScript expression in the page and return the value. Awaits promises. Use for scraping / DOM queries that don't have a dedicated tool.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JS expression." },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_console_messages",
    description:
      "Return the most recent console messages from the driver tab (since debugger attach). Each entry has level, text, ts. Pass clear:true to drain the buffer after reading.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer" },
        clear: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network_requests",
    description:
      "Return the most recent network requests the driver tab has made (since debugger attach). Each entry has method, url, status, mime, ts. Pass clear:true to drain.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer" },
        clear: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args, _attempt = 1) {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [500, 1500, 3000];
  // browser_wait_for can legitimately wait the full minute; budget the
  // HTTP timeout above the bridge's per-command timeout so we don't
  // give up before the bridge does.
  const wantedMs =
    typeof args?.time === "number" && args.time > 0
      ? Math.min(120_000, args.time + 15_000)
      : 75_000;
  let res;
  try {
    res = await fetch(`${DASHBOARD_URL}/api/internal/ext-tools`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ tool: name, args: args || {}, timeoutMs: wantedMs }),
    });
  } catch (err) {
    if (_attempt < MAX_RETRIES) {
      process.stderr.write(
        `[ext-mcp] fetch failed (attempt ${_attempt}/${MAX_RETRIES}), retrying: ${String(err).slice(0, 120)}\n`,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[_attempt - 1]));
      return callTool(name, args, _attempt + 1);
    }
    throw new Error(
      `network error after ${MAX_RETRIES} attempts: ${String(err).slice(0, 120)}`,
    );
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (_attempt < MAX_RETRIES) {
      process.stderr.write(
        `[ext-mcp] non-JSON response (${res.status}, attempt ${_attempt}/${MAX_RETRIES}), retrying\n`,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[_attempt - 1]));
      return callTool(name, args, _attempt + 1);
    }
    throw new Error(
      `dashboard returned non-JSON after ${MAX_RETRIES} attempts (${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (res.status >= 500 && _attempt < MAX_RETRIES) {
    process.stderr.write(
      `[ext-mcp] server error ${res.status} (attempt ${_attempt}/${MAX_RETRIES}), retrying\n`,
    );
    await new Promise((r) => setTimeout(r, RETRY_DELAYS[_attempt - 1]));
    return callTool(name, args, _attempt + 1);
  }
  if (!res.ok || !json.ok) {
    throw new Error(
      json && json.error ? json.error : `dashboard returned ${res.status}`,
    );
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
      serverInfo: { name: "amaso-extension", version: "1.0.0" },
    });
    return;
  }
  if (typeof method === "string" && method.startsWith("notifications/")) {
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
      // Screenshot tool returns base64 — surface it as an image content
      // block so the model can actually see it. Everything else gets
      // JSON-stringified into a text block.
      if (
        name === "browser_take_screenshot" &&
        result &&
        typeof result === "object" &&
        typeof result.base64 === "string"
      ) {
        reply(id, {
          content: [
            {
              type: "image",
              data: result.base64,
              mimeType: result.mimeType || "image/png",
            },
          ],
        });
        return;
      }
      const text =
        typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
      reply(id, { content: [{ type: "text", text }] });
    } catch (err) {
      reply(id, {
        content: [
          {
            type: "text",
            text: `Error: ${err && err.message ? err.message : String(err)}`,
          },
        ],
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
    process.stderr.write(
      `[ext-mcp] handle error: ${err && err.stack ? err.stack : String(err)}\n`,
    );
  });
});
rl.on("close", () => process.exit(0));
