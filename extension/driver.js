// Amaso Driver — translates browser_* tool calls into Chrome DevTools
// Protocol commands against a single attached tab.
//
// Lifecycle:
//   - One tab is "the driver target" at any moment, tracked in
//     chrome.storage.local as `driverTabId`. The popup or a tool call
//     can change it (browser_tabs select).
//   - chrome.debugger.attach is sticky: once attached we keep it until
//     the tab closes or the user explicitly detaches. Reattach is idempotent.
//   - Per-tab state (snapshot ref→backendNodeId map, console buffer,
//     network buffer) lives in `tabState` keyed by tabId. Cleared when
//     the tab closes.
//
// Tool surface mirrors @playwright/mcp closely so spar prompts written
// against Playwright keep working:
//   browser_navigate, browser_navigate_back, browser_click, browser_type,
//   browser_press_key, browser_take_screenshot, browser_snapshot,
//   browser_wait_for, browser_hover, browser_select_option,
//   browser_fill_form, browser_tabs, browser_close, browser_resize,
//   browser_evaluate, browser_console_messages, browser_network_requests
//
// Selector vs ref: every targeting tool accepts either a CSS `selector`
// or a `ref` from the most recent browser_snapshot. Refs map to
// CDP backendNodeId so they survive reflow that would invalidate a
// `selector`-based approach. Pass one or the other; ref wins if both.

const DEBUGGER_PROTOCOL_VERSION = "1.3";

// Per-tab volatile state.
const tabState = new Map();
function getTabState(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    s = {
      attached: false,
      enabled: false,
      refMap: new Map(), // ref string -> backendNodeId
      nextRef: 1,
      consoleBuffer: [], // { level, text, ts, args? }
      networkBuffer: [], // { method, url, status, mime, ts }
      requestsByCdpId: new Map(), // requestId -> partial entry
    };
    tabState.set(tabId, s);
  }
  return s;
}

const CONSOLE_BUFFER_MAX = 500;
const NETWORK_BUFFER_MAX = 500;

// CDP debugger send promisified. chrome.debugger.sendCommand uses a
// callback; if a command fails (target detached, bad params) the error
// shows up in chrome.runtime.lastError. We surface that as a thrown
// Error so the caller's try/catch handles it consistently.
function cdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(res);
    });
  });
}

async function attachIfNeeded(tabId) {
  const s = getTabState(tabId);
  if (s.attached) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
      if (chrome.runtime.lastError) {
        // "Another debugger is already attached" — DevTools is open
        // on this tab. We could ask the user to close DevTools, but
        // for now we surface the error verbatim.
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
  s.attached = true;
  // Enable the domains we use. Page+DOM+Runtime are mandatory; the
  // others are best-effort (the user might not care about console or
  // network logs and these calls are cheap so we just enable).
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "DOM.enable");
  await cdp(tabId, "Runtime.enable");
  await cdp(tabId, "Accessibility.enable");
  try {
    await cdp(tabId, "Log.enable");
  } catch {
    /* not all builds expose Log; ignore */
  }
  try {
    await cdp(tabId, "Network.enable");
  } catch {
    /* ignore */
  }
  s.enabled = true;
}

// Detach helper, called when the tab closes or the user explicitly asks.
async function detach(tabId) {
  const s = tabState.get(tabId);
  if (!s) return;
  if (s.attached) {
    try {
      await new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
          // ignore lastError — tab may already be gone
          void chrome.runtime.lastError;
          resolve();
        });
      });
    } catch {
      /* ignore */
    }
  }
  tabState.delete(tabId);
}

// Wire up debugger event sink for console + network logs. Called once
// in the background on module import.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const s = tabState.get(tabId);
  if (!s) return;

  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || [])
      .map((a) => stringifyRemote(a))
      .join(" ");
    s.consoleBuffer.push({
      level: params.type || "log",
      text,
      ts: params.timestamp || Date.now(),
    });
    if (s.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
      s.consoleBuffer.splice(0, s.consoleBuffer.length - CONSOLE_BUFFER_MAX);
    }
    return;
  }
  if (method === "Runtime.exceptionThrown") {
    const ex = params.exceptionDetails || {};
    s.consoleBuffer.push({
      level: "error",
      text:
        (ex.exception && ex.exception.description) ||
        ex.text ||
        "uncaught exception",
      ts: ex.timestamp || Date.now(),
    });
    if (s.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
      s.consoleBuffer.splice(0, s.consoleBuffer.length - CONSOLE_BUFFER_MAX);
    }
    return;
  }
  if (method === "Log.entryAdded") {
    const e = params.entry || {};
    s.consoleBuffer.push({
      level: e.level || "log",
      text: e.text || "",
      ts: e.timestamp || Date.now(),
    });
    if (s.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
      s.consoleBuffer.splice(0, s.consoleBuffer.length - CONSOLE_BUFFER_MAX);
    }
    return;
  }
  if (method === "Network.requestWillBeSent") {
    s.requestsByCdpId.set(params.requestId, {
      method: params.request && params.request.method,
      url: params.request && params.request.url,
      ts: Date.now(),
    });
    return;
  }
  if (method === "Network.responseReceived") {
    const req = s.requestsByCdpId.get(params.requestId) || {};
    s.networkBuffer.push({
      method: req.method || "",
      url: (params.response && params.response.url) || req.url || "",
      status: params.response && params.response.status,
      mime: params.response && params.response.mimeType,
      ts: Date.now(),
    });
    s.requestsByCdpId.delete(params.requestId);
    if (s.networkBuffer.length > NETWORK_BUFFER_MAX) {
      s.networkBuffer.splice(
        0,
        s.networkBuffer.length - NETWORK_BUFFER_MAX,
      );
    }
    return;
  }
});

// Clean up state when the user closes a driver tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  void detach(tabId);
});

// Detect external detach (user clicked "cancel" on the yellow infobar)
// and update local state so the next op re-attaches.
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const s = tabState.get(tabId);
  if (s) {
    s.attached = false;
    s.enabled = false;
  }
  console.log(`[driver] detached tabId=${tabId} reason=${reason}`);
});

function stringifyRemote(remote) {
  if (!remote) return "";
  if (remote.type === "string") return String(remote.value ?? "");
  if (remote.type === "number" || remote.type === "boolean") {
    return String(remote.value);
  }
  if (remote.type === "undefined") return "undefined";
  if (remote.type === "object" && remote.value === null) return "null";
  return remote.description || JSON.stringify(remote.value ?? null);
}

// ---- Driver target resolution ------------------------------------

async function getActiveDriverTabId() {
  const stored = await chrome.storage.local.get(["driverTabId"]);
  if (stored.driverTabId) {
    // Confirm the tab still exists.
    try {
      const tab = await chrome.tabs.get(stored.driverTabId);
      if (tab && tab.id != null) return tab.id;
    } catch {
      /* tab gone */
    }
  }
  // Fall back to the active tab in the focused window so a fresh
  // install just works without forcing the user to set anything.
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (active && active.id != null) {
    await chrome.storage.local.set({ driverTabId: active.id });
    return active.id;
  }
  throw new Error(
    "no driver tab — open a tab in your browser and try again, or pick one via the extension popup",
  );
}

async function setDriverTabId(tabId) {
  await chrome.storage.local.set({ driverTabId: tabId });
}

// ---- Element resolution -----------------------------------------

// Resolve a target spec to a CDP `objectId` we can use with mouse/key
// dispatch helpers. Accepts either a `ref` from a prior snapshot or a
// CSS `selector`.
async function resolveTarget(tabId, spec) {
  const s = getTabState(tabId);
  if (spec && typeof spec.ref === "string") {
    const backendNodeId = s.refMap.get(spec.ref);
    if (!backendNodeId) {
      throw new Error(`unknown ref: ${spec.ref} (call browser_snapshot first)`);
    }
    const { object } = await cdp(tabId, "DOM.resolveNode", {
      backendNodeId,
    });
    return { objectId: object.objectId, backendNodeId };
  }
  if (spec && typeof spec.selector === "string") {
    const expr = `document.querySelector(${JSON.stringify(spec.selector)})`;
    const res = await cdp(tabId, "Runtime.evaluate", {
      expression: expr,
      includeCommandLineAPI: false,
      returnByValue: false,
    });
    if (!res.result || !res.result.objectId) {
      throw new Error(`selector matched no element: ${spec.selector}`);
    }
    const desc = await cdp(tabId, "DOM.describeNode", {
      objectId: res.result.objectId,
    });
    return {
      objectId: res.result.objectId,
      backendNodeId: desc.node && desc.node.backendNodeId,
    };
  }
  throw new Error("target requires either `ref` or `selector`");
}

async function elementCenter(tabId, objectId) {
  const res = await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({block: "center", inline: "center"});
      const r = this.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2,
               width: r.width, height: r.height };
    }`,
    returnByValue: true,
  });
  if (!res.result || !res.result.value) {
    throw new Error("could not measure element");
  }
  const v = res.result.value;
  if (v.width === 0 && v.height === 0) {
    throw new Error("element has zero size (display:none or detached?)");
  }
  return v;
}

async function focusElement(tabId, objectId) {
  await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.focus && this.focus(); }`,
    returnByValue: true,
  });
}

// ---- Tool implementations ---------------------------------------

const tools = {
  async browser_navigate(args) {
    const tabId = await getActiveDriverTabId();
    if (!args || typeof args.url !== "string") {
      throw new Error("browser_navigate requires { url }");
    }
    // chrome.tabs.update is friendlier than CDP Page.navigate — no
    // attach needed, no infobar — for plain navigation.
    await chrome.tabs.update(tabId, { url: args.url });
    // Wait for load complete so the next snapshot/click sees the new
    // page. Bound the wait so a slow / hanging page can't deadlock.
    await waitForTabLoad(tabId, 30_000);
    // Reset the per-tab snapshot map; old refs point at the previous DOM.
    const s = getTabState(tabId);
    s.refMap.clear();
    s.nextRef = 1;
    return { url: (await chrome.tabs.get(tabId)).url };
  },

  async browser_navigate_back() {
    const tabId = await getActiveDriverTabId();
    await chrome.tabs.goBack(tabId);
    await waitForTabLoad(tabId, 15_000);
    return { url: (await chrome.tabs.get(tabId)).url };
  },

  async browser_click(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    const { objectId } = await resolveTarget(tabId, args);
    const center = await elementCenter(tabId, objectId);
    const x = Math.round(center.x);
    const y = Math.round(center.y);
    const button =
      args && args.button === "right"
        ? "right"
        : args && args.button === "middle"
          ? "middle"
          : "left";
    const clickCount = args && args.doubleClick ? 2 : 1;
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
      clickCount,
    });
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount,
    });
    return { clicked: { x, y, button } };
  },

  async browser_type(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    if (!args || typeof args.text !== "string") {
      throw new Error("browser_type requires { text }");
    }
    const { objectId } = await resolveTarget(tabId, args);
    await focusElement(tabId, objectId);
    if (args.clear) {
      // Select all + delete to clear the field cleanly. Some inputs
      // ignore programmatic .value = "" so we drive it via key events.
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        modifiers: 4, // ctrl
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
      });
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: 4,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
      });
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
    }
    // Input.insertText fires a real `input` event with the right data,
    // unlike sequential char-by-char keyDowns which miss IME/composition
    // semantics and feel slow for long strings.
    await cdp(tabId, "Input.insertText", { text: args.text });
    if (args.submit || args.pressEnter) {
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
      });
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    }
    return { typed: args.text.length };
  },

  async browser_press_key(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    if (!args || typeof args.key !== "string") {
      throw new Error("browser_press_key requires { key }");
    }
    const k = mapKey(args.key);
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...k });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...k });
    return { pressed: args.key };
  },

  async browser_take_screenshot(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    const format = args && args.format === "jpeg" ? "jpeg" : "png";
    const captureBeyondViewport = !!(args && args.fullPage);
    const res = await cdp(tabId, "Page.captureScreenshot", {
      format,
      captureBeyondViewport,
      ...(format === "jpeg" ? { quality: 70 } : {}),
    });
    return {
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      base64: res.data,
    };
  },

  async browser_snapshot() {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    const s = getTabState(tabId);
    s.refMap.clear();
    s.nextRef = 1;
    const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
    // Build a parent map and render YAML-ish text. Each interesting
    // node gets a fresh ref the model can quote back at us.
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const lines = [];
    const root = nodes.find((n) => !n.parentId) || nodes[0];
    if (!root) return { snapshot: "(empty)" };

    const walk = (node, depth) => {
      const role = (node.role && node.role.value) || "";
      if (!role) {
        for (const cid of node.childIds || []) {
          const c = byId.get(cid);
          if (c) walk(c, depth);
        }
        return;
      }
      const name = (node.name && node.name.value) || "";
      const value = (node.value && node.value.value) || "";
      const ignored = node.ignored;
      // Skip ignored nodes unless they have a meaningful name; the AX
      // tree is enormous and surfacing every <div role="presentation">
      // makes the snapshot useless to the model.
      if (ignored && !name) {
        for (const cid of node.childIds || []) {
          const c = byId.get(cid);
          if (c) walk(c, depth);
        }
        return;
      }
      let ref = null;
      if (
        node.backendDOMNodeId != null &&
        // Only mint refs for things the model might want to act on.
        // Excluding pure structural roles keeps the ref namespace tight.
        !["StaticText", "generic", "presentation", "none"].includes(role)
      ) {
        ref = `ref_${s.nextRef++}`;
        s.refMap.set(ref, node.backendDOMNodeId);
      }
      const tag = role;
      const label = name ? ` ${JSON.stringify(name)}` : "";
      const valueStr = value ? ` value=${JSON.stringify(value)}` : "";
      const refStr = ref ? ` [${ref}]` : "";
      lines.push(`${"  ".repeat(depth)}- ${tag}${label}${valueStr}${refStr}`);
      for (const cid of node.childIds || []) {
        const c = byId.get(cid);
        if (c) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    const tab = await chrome.tabs.get(tabId);
    return {
      url: tab.url,
      title: tab.title,
      snapshot: lines.join("\n"),
    };
  },

  async browser_wait_for(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    const timeoutMs = clampInt(args && args.time, 1000, 60_000, 5000);
    const text = args && typeof args.text === "string" ? args.text : null;
    const textGone =
      args && typeof args.textGone === "string" ? args.textGone : null;
    const selector =
      args && typeof args.selector === "string" ? args.selector : null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let cond;
      if (selector) {
        cond = `!!document.querySelector(${JSON.stringify(selector)})`;
      } else if (text) {
        cond = `document.body && document.body.innerText.indexOf(${JSON.stringify(text)}) >= 0`;
      } else if (textGone) {
        cond = `document.body && document.body.innerText.indexOf(${JSON.stringify(textGone)}) < 0`;
      } else {
        // Plain "wait N ms" mode.
        await sleep(timeoutMs);
        return { waited: timeoutMs };
      }
      const { result } = await cdp(tabId, "Runtime.evaluate", {
        expression: cond,
        returnByValue: true,
      });
      if (result && result.value === true) {
        return { waited: Date.now() - start };
      }
      await sleep(150);
    }
    throw new Error(
      `browser_wait_for timed out after ${timeoutMs}ms (${selector || text || textGone || "no condition"})`,
    );
  },

  async browser_hover(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    const { objectId } = await resolveTarget(tabId, args);
    const c = await elementCenter(tabId, objectId);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(c.x),
      y: Math.round(c.y),
    });
    return { hovered: { x: c.x, y: c.y } };
  },

  async browser_select_option(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    const values = Array.isArray(args && args.values)
      ? args.values
      : args && args.value != null
        ? [args.value]
        : [];
    if (values.length === 0) {
      throw new Error("browser_select_option requires { values: [...] }");
    }
    const { objectId } = await resolveTarget(tabId, args);
    const res = await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(values) {
        if (this.tagName !== "SELECT") throw new Error("not a <select>");
        const set = new Set(values.map(String));
        let any = false;
        for (const opt of this.options) {
          const match = set.has(opt.value) || set.has(opt.text);
          opt.selected = match;
          if (match) any = true;
        }
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return any;
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
    });
    if (!res.result || !res.result.value) {
      throw new Error("none of the requested values matched any <option>");
    }
    return { selected: values };
  },

  async browser_fill_form(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    const fields = Array.isArray(args && args.fields) ? args.fields : [];
    if (fields.length === 0) {
      throw new Error("browser_fill_form requires { fields: [...] }");
    }
    const filled = [];
    for (const f of fields) {
      const { objectId } = await resolveTarget(tabId, f);
      await focusElement(tabId, objectId);
      // Clear via select-all+delete, same as browser_type.
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        modifiers: 4,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
      });
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: 4,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
      });
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
      await cdp(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
      await cdp(tabId, "Input.insertText", { text: String(f.value ?? "") });
      filled.push(f.ref || f.selector || "?");
    }
    return { filled };
  },

  async browser_tabs(args) {
    const action = (args && args.action) || "list";
    if (action === "list") {
      const tabs = await chrome.tabs.query({});
      const driverId = (await chrome.storage.local.get(["driverTabId"]))
        .driverTabId;
      return {
        tabs: tabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
          isDriver: t.id === driverId,
        })),
      };
    }
    if (action === "select") {
      if (typeof args.id !== "number") {
        throw new Error("browser_tabs select requires { id }");
      }
      await setDriverTabId(args.id);
      try {
        await chrome.tabs.update(args.id, { active: true });
      } catch {
        /* tab might be in another window — non-fatal */
      }
      return { driverTabId: args.id };
    }
    if (action === "new") {
      const tab = await chrome.tabs.create({
        url: (args && args.url) || "about:blank",
        active: true,
      });
      if (tab.id != null) await setDriverTabId(tab.id);
      return { id: tab.id, url: tab.url };
    }
    if (action === "close") {
      const id = args && typeof args.id === "number" ? args.id : null;
      const tabId = id ?? (await getActiveDriverTabId());
      await detach(tabId);
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    }
    throw new Error(`unknown browser_tabs action: ${action}`);
  },

  async browser_close() {
    const tabId = await getActiveDriverTabId();
    await detach(tabId);
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async browser_resize(args) {
    if (
      !args ||
      typeof args.width !== "number" ||
      typeof args.height !== "number"
    ) {
      throw new Error("browser_resize requires { width, height }");
    }
    const tabId = await getActiveDriverTabId();
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, {
      width: args.width,
      height: args.height,
    });
    return { width: args.width, height: args.height };
  },

  async browser_evaluate(args) {
    const tabId = await getActiveDriverTabId();
    await attachIfNeeded(tabId);
    if (!args || typeof args.expression !== "string") {
      throw new Error("browser_evaluate requires { expression }");
    }
    const { result, exceptionDetails } = await cdp(tabId, "Runtime.evaluate", {
      expression: args.expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(
        (exceptionDetails.exception &&
          exceptionDetails.exception.description) ||
          exceptionDetails.text ||
          "evaluate failed",
      );
    }
    return { value: result ? result.value : undefined };
  },

  async browser_console_messages(args) {
    const tabId = await getActiveDriverTabId();
    const s = getTabState(tabId);
    const limit = clampInt(args && args.limit, 1, CONSOLE_BUFFER_MAX, 100);
    const slice = s.consoleBuffer.slice(-limit);
    if (args && args.clear) s.consoleBuffer.length = 0;
    return { messages: slice };
  },

  async browser_network_requests(args) {
    const tabId = await getActiveDriverTabId();
    const s = getTabState(tabId);
    const limit = clampInt(args && args.limit, 1, NETWORK_BUFFER_MAX, 100);
    const slice = s.networkBuffer.slice(-limit);
    if (args && args.clear) s.networkBuffer.length = 0;
    return { requests: slice };
  },
};

// Map a friendly key name to the CDP keyDown payload. CDP wants both
// `key`, `code`, and `windowsVirtualKeyCode` for navigation keys to
// dispatch correctly across all sites; printable chars also want `text`
// so the input event surfaces the character.
function mapKey(name) {
  const N = String(name);
  const M = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  };
  if (M[N]) return M[N];
  // Single printable character — dispatch as text.
  if (N.length === 1) {
    return { key: N, text: N };
  }
  // Unknown name — pass through as `key` and hope the page handles it.
  return { key: N };
}

function clampInt(v, lo, hi, def) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(hi, Math.max(lo, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.status === "complete") {
          resolve();
          return;
        }
      } catch {
        resolve(); // tab gone — let the caller handle the next op
        return;
      }
      if (Date.now() > deadline) {
        resolve(); // best-effort; caller proceeds even if still loading
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Single entry point used by background.js.
export async function runTool(name, args) {
  const fn = tools[name];
  if (!fn) throw new Error(`unknown tool: ${name}`);
  return fn(args || {});
}

export async function setActiveDriverTab(tabId) {
  await setDriverTabId(tabId);
}

export async function getActiveDriverTab() {
  try {
    return await getActiveDriverTabId();
  } catch {
    return null;
  }
}
