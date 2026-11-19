# Offline use (opt-in)

Offline use is **off by default**: saving the book on a device downloads a few
MB, which matters on mobile data, so nothing is downloaded until the reader
turns on **Settings → 📴 Offline copy** (the switch in the header menu, and the
same switch on Home). Turning it off unregisters the worker and deletes
everything it saved. The setting is `offline` in the `settings` object
(`src/core/settings.js`).

With the switch on, `sw.js` (a service worker) lets the book open with no
signal. What it does:

- **Saves the app itself.** It crawls `index.html` → its `<script>` and `<link>`
  tags → every module each script imports → every `url()` in the CSS, and saves
  all of it plus `data.json`. There is no file list to maintain; a new module is
  picked up the next time the worker updates.
- **Saves the pictures.** After activating, it saves every image `data.json`
  uses, one at a time. A missing image is reported but never breaks the rest.
- **Shows progress on Home**, under the switch: *Saving a copy…*, *Ready to use
  offline (about 2.2 MB)*, *Offline copy incomplete*, or *You're offline —
  showing the copy saved on this device*.
- **Data use.** Turning it on downloads the app and the pictures once (about
  2 MB at the time of writing). Afterwards a visit sends a few dozen tiny "has
  this changed?" requests that come back "no" with no content, and downloads
  only the files that actually changed. Turning it off removes the saved copy.
- **Online readers always get the latest.** Pages, scripts, styles and
  `data.json` are network-first; the saved copy is used when offline or when
  the network does not answer within 3 seconds. After one timeout the saved
  copy is used straight away for 30 seconds (otherwise each file in the page's
  load chain would wait its own 3 seconds).
- **Repairs itself.** If the saved app files go missing (storage cleared, or the
  switch turned off and on again in the same tab), turning on or retrying re-saves
  them as well as the pictures. It retries at most twice per page load and then
  says how to try again (*turn the switch off and on*) instead of looping.
- **Saves the video thumbnails kept in the project** (`assets/images/thumbs/<videoId>.jpg`),
  best effort and just before the pictures. They are not counted in the
  "Saving… 4/11" progress, so a video without one never makes the copy look
  incomplete: it shows the plain "Video" tile.
- **Leaves other sites alone.** The YouTube fallback for a thumbnail is not saved
  (offline the card shows the plain tile); videos need a connection anyway. QR codes
  are drawn by the page itself, so they work offline with nothing to save.

Things to know:

- A device has to open the site **once online** with the switch on, and stay on
  Home until the line says *Ready*. That is the whole setup.
- **iPhone/iPad:** Safari may delete a website's saved data after about a week
  of not using it (unless the site is added to the Home Screen). Offline can
  therefore quietly disappear for someone who opens the book rarely.
- Change `VERSION` at the top of `sw.js` to make every device discard its saved
  copy and download everything again. Normal content changes don't need it.
- It only runs over https or `localhost` (in other browsers the switch is
  disabled with an explanation), and is skipped under automation (Playwright,
  Puppeteer, `scripts/render-prints.js`) so it can't interfere with mocked
  requests or print rendering. Tests that need it open `/?sw=on`
  (`test/e2e/core/offline.test.js`).
- To reset while developing: turn the switch off, or DevTools → Application →
  Service Workers → *Unregister*, and Storage → *Clear site data*.
