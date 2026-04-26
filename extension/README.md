# Amaso Recorder (Chrome extension)

Captures user actions for the dashboard's recording sessions.

## Wire format

Events sent from `content.js` to `background.js` to the dashboard match
the `RecordingEvent` type defined in `../types/recording.ts`. The
extension is plain JS (no build step) so the type isn't imported —
keep the field names in sync by hand when changing the schema.

## How sessions are bound

The dashboard's launcher (`lib/recording-launcher.ts`) opens Chrome
with `--load-extension=./extension` and an initial URL that includes
`#recording=<sessionId>`. `background.js` watches `webNavigation` for
that fragment and persists the id + dashboard origin to
`chrome.storage.local`. Subsequent flushes POST to
`<dashboardOrigin>/api/recording/sessions/<id>/events` with
`credentials: "include"` so the dashboard's session cookie authorizes
the request.

## Loading manually (without the launcher)

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

## Privacy

- Password fields are never captured.
- Inputs flush on `blur` with the final value, never per keystroke.
- `keydown` only emits for `Enter` / `Escape` / `Tab` to mark intent
  without reconstructing typed text.
