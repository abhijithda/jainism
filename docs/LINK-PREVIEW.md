# Link preview (WhatsApp, Facebook, Telegram, X)

The `<meta property="og:…">` tags in `index.html` give shared links a title,
description and picture, using `assets/images/og-image.jpg` (1200×630, about 210 KB: WhatsApp
may ignore images much over ~300 KB). Chat apps read these tags from the raw
HTML and never run JavaScript, so they can't be generated in the browser. The
only address that has to be written out is the one in `og:image`, which must be
an absolute https URL (`https://abhijithda.github.io/jainism/assets/images/og-image.jpg`).
If the site moves, change that one line. `og:url` is left out on purpose
(optional), and X reuses the `og:` title, description and image.

**Changing the book's title or subtitle.** They are written once, in the cover
block of `data.json` (`data[0].blocks[0].content`: the first line of `kn` and
`en` is the title, the second the subtitle). The Home cover, the book view's
running head, the browser/print title, the share bar, the print file names and
the release name all read it from there. Two things cannot, so after a change:
run `npm run sync:title` (rewrites the four link-preview spots in `index.html`;
the tests fail until you do), and redo `assets/images/og-image.jpg`, which has the title
drawn into the picture. Check the printed page header of the Book view once,
since its spacing is estimated from the title lengths (`src/core/book-title.js`).

Chat apps remember a link's preview. After changing `assets/images/og-image.jpg` or the text,
an already-shared link can keep the old preview for days; sharing the link with
a changed ending (`…/jainism/?v=2`) shows the new one straight away.
