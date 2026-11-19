# Video thumbnails and QR codes

**QR codes are drawn in the browser** (`src/core/qr.js`, used by `createVideoCard` in
`src/core/media.js`) from the video link already in `data.json`: no files to keep in
step, no third-party service, and they work offline and as vector shapes in the
PDFs. The encoder handles QR versions 1-20 (a link needs 10 at most). It was
checked by decoding its output with OpenCV: every version at all four error
correction levels, the first and last text length of each version, all the video
links in `data.json`, and Kannada text. `src/core/qr.test.js` keeps three
known-answer codes.

**Thumbnails are kept in the repo** as `assets/images/thumbs/<videoId>.jpg`, so they
work in the offline copy, the print builds don't depend on YouTube being
reachable, and a video that is later deleted keeps the picture that shows what
it was.

- Add or change a video in `data.json`, then run `npm run thumbs` (needs
  internet; downloads only what is missing) and commit `assets/images/thumbs/` and
  `assets/images/thumbs/unavailable.json`. Or run the **Update Thumbnails** GitHub workflow
  (Actions tab; `commit` pushes them to the branch, `artifact` gives you a zip to
  review first). It is quick: it only needs Node, no `npm ci`, no browsers.
- `npm run thumbs:check` lists missing thumbnails without using the network. The
  Jest test in `data.test.js` runs the same check, so CI fails (naming the video
  ids) instead of readers seeing an empty box.
- YouTube answers a deleted or private video with a 404 or a small grey stand-in
  picture. Those are not saved; the id is recorded in `assets/images/thumbs/unavailable.json`
  so it isn't retried on every run (`--retry-unavailable` looks again). The page
  then falls back to whatever YouTube itself returns.
- In the page, a thumbnail that fails to load tries YouTube once, and if that
  fails too (offline) the card shows a plain dark "Video" tile
  (`.video-card.thumb-failed`) instead of a broken-image box.
- The print run (`scripts/render-prints.js`) waits for that whole chain to settle
  (`scripts/wait-for-images.js`), including the second try, before it makes each PDF.
- The e2e fixture's videos (`test/data.json`) are fetched too, so the screenshot
  tests don't depend on the internet.
- **Order matters after changing either:** the print/e2e screenshot baselines
  contain thumbnails and QR codes. Run *Update Thumbnails* first, then *Update
  Playwright Snapshots*.
