// Amaso Recorder — content script.
//
// Listens to user actions on every page and forwards them to the
// background worker for batching/flushing. The wire format mirrors
// types/recording.ts (RecordingEvent) — when you change one, change
// the other.
//
// Privacy guards:
//   - Password fields are never captured (no value, no selector).
//   - Inputs are flushed on blur with the final value, never per
//     keystroke.
//   - keydown only fires for navigation keys (Enter, Escape, Tab) —
//     we don't reconstruct typed text, only mark intent.

(() => {
  const SPECIAL_KEYS = new Set(["Enter", "Escape", "Tab"]);
  const inputBuffers = new WeakMap(); // <input> -> last seen value
  let lastUrl = location.href;

  // Send the initial navigation event so a session always has at
  // least one anchor. Subsequent navigations are caught by the
  // popstate / hashchange listeners and the SPA observer below.
  emit({
    type: "navigation",
    target: null,
    value: null,
    needs_clarification: false,
    clarification_reason: null,
    extra: { fromUrl: null },
  });

  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const desc = describeTarget(t);
      const ambiguous = isAmbiguousTarget(desc);
      emit({
        type: "click",
        target: desc,
        value: null,
        needs_clarification: ambiguous.flag,
        clarification_reason: ambiguous.reason,
      });
    },
    true,
  );

  document.addEventListener(
    "blur",
    (e) => {
      const t = e.target;
      if (!isCapturableInput(t)) return;
      const value = readInputValue(t);
      const prior = inputBuffers.get(t);
      if (value === prior) return;
      inputBuffers.set(t, value);
      const desc = describeTarget(t);
      emit({
        type: "input",
        target: desc,
        value,
        needs_clarification: false,
        clarification_reason: null,
      });
    },
    true,
  );

  document.addEventListener(
    "submit",
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const desc = describeTarget(t);
      const ambiguous = isAmbiguousForm(t);
      emit({
        type: "submit",
        target: desc,
        value: null,
        needs_clarification: ambiguous.flag,
        clarification_reason: ambiguous.reason,
      });
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (!SPECIAL_KEYS.has(e.key)) return;
      const t = e.target instanceof Element ? describeTarget(e.target) : null;
      emit({
        type: "keydown",
        target: t,
        value: null,
        key: e.key,
        needs_clarification: false,
        clarification_reason: null,
      });
    },
    true,
  );

  // SPA navigations: history API + hashchange + a fallback URL poll
  // for frameworks that don't emit either reliably.
  for (const fnName of ["pushState", "replaceState"]) {
    const orig = history[fnName];
    history[fnName] = function (...args) {
      const ret = orig.apply(this, args);
      queueMicrotask(checkUrl);
      return ret;
    };
  }
  window.addEventListener("popstate", checkUrl);
  window.addEventListener("hashchange", checkUrl);

  function checkUrl() {
    if (location.href === lastUrl) return;
    const fromUrl = lastUrl;
    lastUrl = location.href;
    emit({
      type: "navigation",
      target: null,
      value: null,
      needs_clarification: false,
      clarification_reason: null,
      extra: { fromUrl },
    });
  }

  function emit(partial) {
    const ev = {
      clientId: cryptoRandomId(),
      type: partial.type,
      timestamp: Date.now(),
      url: location.href,
      title: document.title || null,
      target: partial.target ?? null,
      value: partial.value ?? null,
      needs_clarification: !!partial.needs_clarification,
      clarification_reason: partial.clarification_reason ?? null,
    };
    // Inline the keydown's `key` and navigation's `fromUrl` into the
    // value field so the wire schema stays flat. Both are simple
    // strings; the dashboard knows how to interpret them by type.
    if (partial.key) ev.value = partial.key;
    if (partial.extra && partial.extra.fromUrl)
      ev.value = partial.extra.fromUrl;
    try {
      chrome.runtime.sendMessage({ kind: "events", events: [ev] });
    } catch {
      /* extension context may be invalidated mid-page-unload */
    }
  }

  function cryptoRandomId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function isCapturableInput(t) {
    if (!(t instanceof HTMLInputElement) && !(t instanceof HTMLTextAreaElement)) {
      return t instanceof HTMLSelectElement;
    }
    if (t instanceof HTMLInputElement) {
      const type = (t.type || "text").toLowerCase();
      if (type === "password") return false;
      if (type === "hidden") return false;
      if (type === "file") return false;
    }
    return true;
  }

  function readInputValue(t) {
    if (t instanceof HTMLSelectElement) return t.value;
    return t.value ?? "";
  }

  function describeTarget(el) {
    const rect = (() => {
      try {
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      } catch {
        return null;
      }
    })();
    return {
      selector: bestSelector(el),
      text: textForTarget(el),
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      rect,
    };
  }

  function textForTarget(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim().slice(0, 120);
    const t = (el.textContent ?? "").trim();
    return t ? t.slice(0, 120) : null;
  }

  function bestSelector(el) {
    if (el.id) return `#${cssEscape(el.id)}`;
    const dataTestId = el.getAttribute("data-testid");
    if (dataTestId) return `[data-testid="${cssEscape(dataTestId)}"]`;
    const dataCy = el.getAttribute("data-cy");
    if (dataCy) return `[data-cy="${cssEscape(dataCy)}"]`;
    // Fall back to a positional selector with the element's tag and
    // its class list trimmed to the first three classes (more than
    // that is usually utility CSS noise).
    const cls = (el.className && typeof el.className === "string"
      ? el.className.trim().split(/\s+/).slice(0, 3)
      : []
    )
      .map((c) => `.${cssEscape(c)}`)
      .join("");
    return `${el.tagName.toLowerCase()}${cls}`;
  }

  function isAmbiguousTarget(desc) {
    // Generic positional selector with no text, no role, no id-ish
    // hook. The dashboard surfaces these for human clarification.
    const onlyTag = /^[a-z0-9]+$/.test(desc.selector);
    const noText = !desc.text;
    const noRole = !desc.role;
    if (onlyTag && noText && noRole) {
      return { flag: true, reason: "generic selector with no text/role" };
    }
    if (noText && noRole && !desc.selector.startsWith("#") &&
        !desc.selector.startsWith("[data-")) {
      return { flag: true, reason: "no text label, no aria role" };
    }
    return { flag: false, reason: null };
  }

  function isAmbiguousForm(form) {
    const id = form.getAttribute("id");
    const name = form.getAttribute("name");
    const aria = form.getAttribute("aria-label");
    if (!id && !name && !aria) {
      return { flag: true, reason: "form has no id/name/aria-label" };
    }
    return { flag: false, reason: null };
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  }
})();
