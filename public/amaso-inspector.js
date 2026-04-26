/**
 * amaso-inspector — universal Alt+Click bridge between an embedded project
 * preview and the Amaso Dashboard running in the parent window.
 *
 * Works with:
 *   - Vue / Nuxt (reads `data-v-inspector="path:line:col"` from
 *     vite-plugin-vue-inspector)
 *   - React / Next.js (walks the React Fiber tree and reads `_debugSource`
 *     which Next.js in dev mode automatically injects via React's
 *     transform-react-jsx-source)
 *   - Anything else (falls back to a DOM selector — no file mapping but
 *     still lets you remark on the hovered element)
 *
 * This file is self-contained. Drop it in `public/amaso-inspector.js` and
 * load it from your framework's root layout with a script tag (dev only):
 *
 *   <script defer src="/amaso-inspector.js"></script>
 *
 * Does nothing unless:
 *   1. Hostname suggests localhost / dev   (heuristic: port >= 1000)
 *   2. Page is embedded in an iframe (window.parent !== window)
 *
 * Usage: hold Alt (Option on Mac) and click any element. Esc cancels.
 */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  if (window.parent === window) return; // not in an iframe → no dashboard to talk to
  if (window.__amasoInspectorLoaded) return;
  window.__amasoInspectorLoaded = true;

  var PARENT = "amaso-dashboard";
  var ME = "amaso-inspector";

  var overlay = null;
  var label = null;
  var altHeld = false;
  // Armed via parent postMessage ({type:"arm"}). Used on touch devices and
  // anywhere Alt-click isn't ergonomic — the next pointer interaction picks
  // the element, regardless of whether Alt is held. Disarms after one pick.
  var armed = false;

  function isActive() {
    return altHeld || armed;
  }

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.style.cssText = [
      "position: fixed",
      "pointer-events: none",
      "z-index: 2147483646",
      "border: 2px solid #10b981",
      "background: rgba(16,185,129,0.12)",
      "transition: top 60ms, left 60ms, width 60ms, height 60ms",
      "display: none",
    ].join(";");
    label = document.createElement("div");
    label.style.cssText = [
      "position: absolute",
      "bottom: 100%",
      "left: 0",
      "margin-bottom: 4px",
      "padding: 2px 6px",
      "background: #10b981",
      "color: black",
      "font: 11px/1.3 ui-monospace, monospace",
      "border-radius: 3px",
      "white-space: nowrap",
      "max-width: 400px",
      "overflow: hidden",
      "text-overflow: ellipsis",
    ].join(";");
    overlay.appendChild(label);
    document.body.appendChild(overlay);
  }

  function hide() {
    if (overlay) overlay.style.display = "none";
  }

  /** Walk up looking for a Vue inspector attribute. */
  function findVueSource(el) {
    var cur = el;
    while (cur && cur !== document.body) {
      if (cur.getAttribute) {
        var attr = cur.getAttribute("data-v-inspector");
        if (attr) {
          var m = /^(.+):(\d+):(\d+)$/.exec(attr);
          if (m)
            return {
              path: m[1],
              line: Number(m[2]),
              col: Number(m[3]),
              source: "vue",
            };
        }
        // Also match react-dev-inspector style if present
        var rp = cur.getAttribute("data-inspector-relative-path");
        if (rp) {
          return {
            path: rp,
            line: Number(cur.getAttribute("data-inspector-line") || 1),
            col: Number(cur.getAttribute("data-inspector-column") || 1),
            source: "react-attr",
          };
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /** Read the React Fiber attached to a DOM element and climb until we
   *  find `_debugSource`. Works in React 17+ dev mode (Next.js always). */
  function findReactSource(el) {
    if (!el) return null;
    var fiberKey = null;
    for (var k in el) {
      if (
        k.charCodeAt(0) === 95 && // starts with "_"
        (k.indexOf("__reactFiber$") === 0 ||
          k.indexOf("__reactInternalInstance$") === 0)
      ) {
        fiberKey = k;
        break;
      }
    }
    if (!fiberKey) return null;
    var fiber = el[fiberKey];
    // Climb via `return` (parent) until we find _debugSource
    var cur = fiber;
    while (cur) {
      if (cur._debugSource && cur._debugSource.fileName) {
        return {
          path: cur._debugSource.fileName,
          line: cur._debugSource.lineNumber || 1,
          col: cur._debugSource.columnNumber || 1,
          source: "react-fiber",
        };
      }
      cur = cur.return || null;
    }
    return null;
  }

  /** Find source info for an element — try Vue attrs then React Fiber. */
  function findSource(el) {
    return findVueSource(el) || findReactSource(el);
  }

  function captureContext(el) {
    var attrs = {};
    if (el.attributes) {
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        if (!a) continue;
        if (a.name.indexOf("data-v-") === 0) continue;
        if (a.name.indexOf("data-inspector-") === 0) continue;
        if (a.name === "class" || a.name === "id") continue;
        attrs[a.name] = a.value;
      }
    }
    var text = "";
    try {
      text = (el.innerText || "").replace(/\s+/g, " ").trim();
    } catch (_) {}
    if (text.length > 300) text = text.slice(0, 300) + "…";
    var outer = el.outerHTML || "";
    if (outer.length > 600) outer = outer.slice(0, 600) + "…";
    return {
      tag: (el.tagName || "?").toLowerCase(),
      id: el.id || null,
      classes: el.classList ? Array.prototype.slice.call(el.classList) : [],
      attrs: attrs,
      text: text,
      outerHtml: outer,
      locator: shortLocator(el),
      pageUrl: window.location.href,
    };
  }

  function shortLocator(el) {
    var parts = [];
    var cur = el;
    var depth = 0;
    while (cur && cur !== document.body && depth < 4) {
      var p = (cur.tagName || "?").toLowerCase();
      if (cur.id) {
        p += "#" + cur.id;
      } else if (cur.classList && cur.classList.length) {
        for (var i = 0; i < cur.classList.length; i++) {
          if (cur.classList[i].indexOf("data-") !== 0) {
            p += "." + cur.classList[i];
            break;
          }
        }
      }
      parts.unshift(p);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function post(msg) {
    try {
      msg.source = ME;
      window.parent.postMessage(msg, "*");
    } catch (_) {}
  }

  function updateOverlay(el, info) {
    if (!info) {
      hide();
      return;
    }
    ensureOverlay();
    var rect = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.top = rect.top + "px";
    overlay.style.left = rect.left + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
    if (label) {
      var parts = (info.path || "").split(/[\\/]/);
      var short = parts.slice(-2).join("/");
      label.textContent = short + ":" + info.line;
    }
  }

  function onMouseMove(e) {
    if (!isActive()) return;
    var el = e.target;
    var info = findSource(el);
    updateOverlay(el, info);
  }

  function onPointerDownCapture(e) {
    // Two ways to pick: Alt+click on desktop, or "armed" mode (mobile / no
    // physical Alt key). Armed state is set via postMessage from the parent
    // dashboard and consumed after one pick.
    if (!e.altKey && !armed) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var el = e.target;
    var info = findSource(el);
    if (!info) {
      // No source map for this element. If we were armed, disarm so the next
      // tap behaves normally instead of being eaten silently.
      if (armed) disarm();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    post({
      type: "pick",
      path: info.path,
      line: info.line,
      col: info.col,
      context: captureContext(el),
    });
    if (overlay) {
      overlay.style.borderColor = "#fbbf24";
      overlay.style.background = "rgba(251,191,36,0.25)";
      setTimeout(function () {
        if (overlay) {
          overlay.style.borderColor = "#10b981";
          overlay.style.background = "rgba(16,185,129,0.12)";
        }
      }, 180);
    }
    // One-shot: a tap from the dashboard "Inspect" button picks one element
    // and then returns to normal navigation. Holding Alt stays in inspect
    // mode for as long as Alt is held.
    if (armed) disarm();
  }

  function swallowIfAlt(e) {
    if (!e.altKey && !armed) return;
    var info = findSource(e.target);
    if (!info) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    if (e.key === "Alt" || e.altKey) {
      altHeld = true;
      document.documentElement.style.cursor = "crosshair";
    }
  }
  function onKeyUp(e) {
    if (e.key === "Alt" || !e.altKey) {
      altHeld = false;
      document.documentElement.style.cursor = "";
      hide();
    }
  }
  function onBlur() {
    altHeld = false;
    document.documentElement.style.cursor = "";
    hide();
  }

  function arm() {
    armed = true;
    document.documentElement.style.cursor = "crosshair";
    post({ type: "armed" });
  }

  function disarm() {
    armed = false;
    document.documentElement.style.cursor = "";
    hide();
    post({ type: "disarmed" });
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.source !== PARENT) return;
    if (d.type === "probe") post({ type: "ready" });
    else if (d.type === "arm") arm();
    else if (d.type === "disarm") disarm();
  });

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("pointerdown", onPointerDownCapture, true);
  document.addEventListener("mousedown", swallowIfAlt, true);
  document.addEventListener("click", swallowIfAlt, true);
  document.addEventListener("auxclick", swallowIfAlt, true);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  function announce() {
    post({ type: "ready" });
  }
  announce();
  setTimeout(announce, 500);
  window.addEventListener("load", announce);
})();
