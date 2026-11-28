# Header, Home and settings layout

How the app's chrome is put together, so the next change starts from the same picture.

## Header (`index.html`, `src/header/header.css`)

Left to right: **Home** icon · **Book / Scroll** toggle · **search box** (with the **Ask AI** chip inside) ·
**progress** button · **Study** button · **Full screen** icon · **Settings** icon. All controls are icon buttons; the
words (Book, Scroll, Study) show only on wide screens (`.btn-label`).

* **Search box + Ask AI** (`header/omnibox.js`). Typing still searches as before (`app.js` filters the Scroll view /
  jumps in the Book view on `keyup`). The box also lists up to 5 matching passages (`core/search.js`, label such as
  `A-3.1`); picking one opens it like a cited passage. When the AI assistant is on, the **Ask AI** chip and the last
  row of the list hand the typed text to the Ask panel (`askWith`). It is only filled in, never sent. Ctrl/Cmd+Enter
  does the same. Plain Enter does nothing new.
* **Phone (≤ 700px)**: search is a magnifier icon; tapping it turns the header row into the search box
  (back arrow + box) and the list hangs under the header. Settings open as a bottom sheet with a dimmed page
  (`body.settings-open`). The progress button is just the ring; its card (tap) holds "N of M read" and, when Study is on,
  the **Study questions** row.
* **Progress button** (`header/progress-button.js`): shown while Read tracking is on. Ring, percent and card are
  filled by `core/read-tracking.js` (`updateProgressDisplay`). The ring's badge and the card's Study row mirror the real
  `#study-btn` (owned by `study/study-panel.js`), which stays the single source of truth.
* **Full screen** (`#zen-mode-btn`, arrows icon) = hide the header and ask the browser for full screen. The exit pill
  reads "Exit full screen"; Esc also exits. Internally it is still called zen mode.

## Settings (header dropdown/sheet and Home)

Same groups, same order, in two places (header: `#settings-menu`, ids without a prefix; Home: ids prefixed
`home-`, kept in step by `home/home.js`): **Reading** (Language, Text size, Page size) · **Show with the text**
(Videos, QR codes) · **Progress and learning** (Read tracking → *nested* Study questions, AI assistant + its
Choose service… / Choose model… button) · **Saved on this device and sync** (Offline copy, Sync).

* Page size changes the screen layout as well as print, so it sits under Reading, not under a "Print" heading.
* Study questions needs Read tracking; turning Study on switches tracking on and locks it (note shows in the group).
* The AI assistant is Off | Online | On this device (stored as `off` / `cloud` / `local`). Its button shows whenever it is
  Online or On this device, on the right under the switch, labelled by what there is to choose: "Choose service…" or
  "Choose model…". When the row is too narrow the switch drops under the label, still on the right.
* Page size is Auto | A4 | A3 (stored as `dynamic` / `a4` / `a3`).
* Language is the same searchable picker in the header and on Home (`initLangPicker(cb, 'home-')`); a change in either
  redraws the other. Built for many languages: it stays one row.
* Choices with a few options (Page size, AI assistant) are a row of buttons made from the `<select>` by
  `core/segmented.js`. The select stays in the page (visually hidden) and remains the source of truth.

## Home

Cover and title, then a card with the progress bar, the main **Continue reading / Start reading** button (opens the
view used last), and the Book and Scroll buttons; then the settings groups above.

## Icons

Inline SVG, no icon font: `core/icons.js` (Tabler Icons outline shapes, MIT). In HTML write
`<span class="ic" data-icon="home"></span>`; `hydrateIcons()` fills it in at start. In JS use `icon(document, "x")`.
Add a shape by adding its path list to `PATHS`. (`sync/icons.js` keeps the Sync row's own few icons.)

## Ask AI panel

Title "Ask AI" with a Cloud/Local tag, icon buttons for expand and close, a short note before the first question, a
rounded input with an arrow send button, and a one-line note pointing readers to the book's own references (the cited
passages, shlokas and videos).

## Saved vs synced (the last group of Settings)

Two status lines with a dot (grey = not saved / not syncing, green = yes, blue = working, amber = needs attention):

* **Offline copy** — `#offline-status` (header) and `#home-offline-status` (Home), written by `core/offline.js`:
  "Not saved. Reading needs internet." / "Saving a copy for offline use… 3/20" / "Saved on this device (about 12 MB). Opens without internet."
* **Sync** — the `.sync-hint` line under the Sync row, written by `sync/sync-ui.js`: the signed-out explanation, or
  "Synced just now. Keeps your reading progress, study answers and display settings the same on all your devices."
  The account email is not shown here; the account button's menu has it.

A footer lists what is never synced (offline copy, AI assistant settings and keys, where you stopped reading); it hides
with the Sync row when no Google client ID is set (`assets/sync-config.json`).

## Wording

Reader-facing text calls the content "the FAQs" (the cover reads "Jainism F.A.Q.s"). "Book" is only the name of the
Book view. The hidden instructions sent to the AI model are unchanged.

## Narrow windows

Phone (<= 700px): single row, search behind an icon, settings as a sheet. Tablet / narrow desktop (701–900px): the
words on Book/Scroll and Study go and the progress button is just its ring; the search box keeps a 160px minimum.
