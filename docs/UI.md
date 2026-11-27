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
`home-`, kept in step by `home/home.js`): **Reading** (Language, Text size, Page size) · **Show in the book**
(Videos, QR codes) · **Progress and learning** (Read tracking → *nested* Study questions, AI assistant + Configure…)
· **This device** (Offline copy, Sync).

* Page size changes the screen layout as well as print, so it sits under Reading, not under a "Print" heading.
* Study questions needs Read tracking; turning Study on switches tracking on and locks it (note shows in the group).
* The Configure… button shows whenever the AI assistant is Cloud or Local.
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
