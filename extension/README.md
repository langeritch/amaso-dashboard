# Amaso Recorder + Driver (Chrome extension)

Two jobs, one extension:

1. **Recorder** — captures user actions for the dashboard's recording
   sessions (the original purpose of this extension).
2. **Driver** — exposes Chrome DevTools Protocol to the dashboard's
   sparring partner so it can navigate, click, type, snapshot pages,
   etc., **inside the user's real Chrome session** (with all logins,
   cookies, profile state intact).

## Install

1. Open `chrome://extensions/` → enable Developer mode → "Load
   unpacked" → pick this `extension/` folder.
2. Visit the dashboard once (e.g. `http://localhost:3737` or
   `https://dashboard.amaso.nl`) and log in.
3. Click the extension's toolbar icon, paste the dashboard URL into
   "Dashboard URL" if it isn't already filled, click **Save & connect**.
   The status pill should turn green.

The extension authenticates with the same `amaso_session` cookie your
browser tabs use — no token plumbing needed. Run multiple Chromes if
you want; each instance can connect independently.

## Driver tab

The driver targets one tab at a time. By default it picks the active
tab in the focused window the first time the spar issues a command.
Switch the target manually with the popup's **Use this tab** button,
or have the spar call `browser_tabs` with `action:"select"` /
`action:"new"`.

The first time the driver acts on a tab, Chrome attaches its debugger
and shows a yellow infobar at the top ("Amaso Recorder + Driver
started debugging this browser"). That's expected — it's the cost of
the full DevTools Protocol surface. The infobar stays for the lifetime
of that tab's debugger session; closing the tab detaches cleanly.

## Switching the spar to use this driver

In the dashboard process's environment:

```bash
AMASO_SPAR_DRIVER=extension
```

When set, the spar's MCP config registers `extension-mcp-server.mjs`
instead of `@playwright/mcp`. Tool names (`browser_navigate`,
`browser_click`, `browser_snapshot`, etc.) are identical — the model's
prompt does not need to change.

Unset (or any other value) keeps the original Playwright behaviour.

## Origin allowlist (optional)

By default the dashboard's WebSocket bridge accepts any
`chrome-extension://<id>` origin (the cookie auth is the real gate).
For multi-user dashboards you can tighten this with:

```
AMASO_EXT_BRIDGE_ALLOWED_ORIGINS=abcdefghijklmnopqrstuvwxyzabcdef,otherid
```

Only the listed extension IDs (or full `chrome-extension://...`
origins) will be accepted. The id is the 32-char string at the top of
the extension's `chrome://extensions` card.

## Tool surface

`browser_navigate`, `browser_navigate_back`, `browser_click`,
`browser_type`, `browser_press_key`, `browser_take_screenshot`,
`browser_snapshot`, `browser_wait_for`, `browser_hover`,
`browser_select_option`, `browser_fill_form`, `browser_tabs`,
`browser_close`, `browser_resize`, `browser_evaluate`,
`browser_console_messages`, `browser_network_requests`.

All targeting tools accept either:

- `ref`: an id from the most recent `browser_snapshot` (e.g.
  `"ref_12"`) — survives reflow because it resolves to a CDP
  `backendNodeId`.
- `selector`: a CSS selector — useful when you know the page
  structure or haven't snapshotted recently.

## Recorder (legacy)

The original recorder behaviour is unchanged. See the bottom of this
file for the previous README content.

---

## Recorder details (unchanged)

Captures user actions for the dashboard's recording sessions.

### Wire format

Events sent from `content.js` to `background.js` to the dashboard match
the `RecordingEvent` type defined in `../types/recording.ts`. The
extension is plain JS (no build step) so the type isn't imported —
keep the field names in sync by hand when changing the schema.

### How sessions are bound

The dashboard's launcher (`lib/recording-launcher.ts`) opens Chrome
with `--load-extension=./extension` and an initial URL that includes
`#recording=<sessionId>`. `background.js` watches `webNavigation` for
that fragment and persists the id + dashboard origin to
`chrome.storage.local`. Subsequent flushes POST to
`<dashboardOrigin>/api/recording/sessions/<id>/events` with
`credentials: "include"` so the dashboard's session cookie authorizes
the request.

### Loading manually (without the launcher)

If `RECORDING_CHROME_BINARY` isn't set or you'd rather use your own
Chrome profile:

1. `chrome://extensions/` → enable Developer mode → "Load unpacked"
   → pick this `extension/` folder.
2. Start a session via the header circle icon in the dashboard. Take
   note of the session id from the response (or the URL fragment in
   the launched window).
3. In any tab, run in DevTools console:

   ```js
   chrome.runtime.sendMessage('<EXTENSION_ID>', { kind: 'attach', sessionId: '<UUID>', dashboardOrigin: 'http://localhost:3737' });
   ```

   (Or just open the dashboard with `#recording=<UUID>` appended and
   `webNavigation.onCommitted` will pick it up for you.)

### Privacy

- Password fields are never captured.
- Inputs flush on `blur` with the final value, never per keystroke.
- `keydown` only emits for `Enter` / `Escape` / `Tab` to mark intent
  without reconstructing typed text.
