# Google sign-in and saved history

Optional. Readers can sign in with Google so their **read ticks, study answers and display settings** follow them to
other devices. Signed out, the site works exactly as before (everything stays in the browser).

## How it works

- Progress is saved as one small file, `jainism-progress.json`, in the reader's **own Google Drive "app data" folder**
  (scope `drive.appdata`). That folder is hidden from the reader's Drive list and readable only by this site's sign-in.
  There is no server: the site's owner never sees anyone's data, and there is nothing to host, pay for or secure.
- The browser keeps working from `localStorage` as always. Sync copies to and from Drive in the background:
  at sign-in, a few seconds after a change, when the tab comes back, and when the device is back online.
- **Merging:** every tick, study answer and setting carries the time it last changed; per item, the newer change wins.
  Reading on a phone and a laptop in the same week gives both sets of ticks. Un-ticking on one device un-ticks the
  other (kept as a small "tombstone"). Ticks that existed before sync was switched on are never lost: a first sign-in
  is a union, not a replacement. Code: `src/sync/sync-merge.js` (pure, unit-tested).
- **What is NOT synced:** the offline copy switch, everything about the AI assistant (engine, addresses, model,
  panel width, API keys), and the scroll position. Those are about the device, not the reader.
- **Display settings** found on Drive are offered ("Use settings from my other device"), never forced onto a page
  someone is reading.
- Study answers are stored as short descriptors only, never the book's text (same as on the device).

## Limits worth knowing

- Google's browser-only sign-in gives a token that lasts about an hour and cannot be refreshed in the background.
  Sync re-requests it quietly; if the browser needs a click, Settings shows **Reconnect**. Progress is never lost
  meanwhile; it syncs after reconnecting.
- Two devices syncing in the very same moment can overwrite each other's upload once; each keeps its own data and
  merges again at its next sync.
- Sign-out keeps the history on the device. "Delete synced data" (in the account menu) signs out and also removes the Drive file.

## One-time setup (site owner)

1. In <https://console.cloud.google.com/>, create (or pick) a project.
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **OAuth consent screen**: user type *External*; add the app name, your support email and the site's privacy
   details. Set **Application home page** to `https://abhijithda.github.io/jainism/` and **Application privacy policy link**
   to `https://abhijithda.github.io/jainism/privacy.html` (the `privacy.html` page in this repo; keep it deployed at that
   address, and if the site moves, update the page and these two links together). Add scope `…/auth/drive.appdata` (a non-sensitive scope, so Google needs no review). Click
   **Publish app** to move from *Testing* (100 named test users only) to *In production*.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under *Authorized JavaScript origins*
   add `https://abhijithda.github.io` (and `http://localhost:8080` for local testing). No redirect URIs are needed.
5. Put the client ID (`…apps.googleusercontent.com`; a public identifier, not a secret) in
   `assets/sync-config.json`:
   ```json
   { "googleClientId": "1234567890-abc123.apps.googleusercontent.com" }
   ```
6. Deploy. A **☁️ Save progress** section appears in Settings and on Home. With the ID empty it stays hidden and no
   request is ever made to Google.

## Files

| File | Job |
|---|---|
| `assets/sync-config.json` | The client ID (empty = feature off) |
| `src/sync/sync-config.js` | Reads and validates it |
| `src/sync/auth.js` | Google Identity Services sign-in; loads Google's script only when asked |
| `src/sync/drive.js` | The five Drive calls (find, read, write, delete, who am I) |
| `src/sync/sync-merge.js` | Change times, the merge, applying it to `localStorage` |
| `src/sync/sync-engine.js` | When to sync; status; sign-out |
| `src/sync/sync-ui.js`, `icons.js`, `sync.css` | The Sync row (status icon, refresh, account menu), built into both Settings and Home |
| `src/sync/index.js` | Wires it together for `app.js` |
| `privacy.html` | The privacy policy Google's consent screen links to (also linked from Settings and Home) |

Small hooks elsewhere: `read-tick.js` (tick ids, `repaintReadTicks`), `settings.js` (announces saves),
`study-panel.js` (announces answers, `refreshStudyLog`), `sw.js` (saves the config for offline use).
