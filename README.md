# Jainism F.A.Q.s

[![CI](https://github.com/abhijithda/jainism/actions/workflows/ci.yml/badge.svg)](https://github.com/abhijithda/jainism/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Read it online: <https://abhijithda.github.io/jainism/>**

*Commonly confused concepts, clarified.* A multi-lingual (Kannada, English primarily)
question-and-answer book about Jaina pooja and related ideas. A question is
answered, and follow-up questions build on parts of those answers. Reference
videos, shlokas, mantras, notes and pictures sit alongside, so you can read at
your own pace and come back to it.

<!-- Add screenshots here, for example:
![Book view](docs/screenshots/book-view.png)
![Continuous view](docs/screenshots/continuous-view.png)
-->

## What you can do

- **Read it your way.** The *Book* view shows numbered pages; the *Continuous*
  view is one long page you scroll.
- **Choose your language.** Kannada, English, or both side by side.
- **Watch the reference videos.** Videos play on YouTube. Switch on 🎬 Videos for
  thumbnails and 📱 QR Codes to scan a code with your phone, or use both.
- **Keep track of what you have read**, and make the text bigger or smaller.
- **Share one question or answer.** Every card and paragraph has a link of its own.
- **Read without internet.** Turn on **Settings → 📴 Offline copy** once while
  online. It is off by default because it saves a few MB on your device
  ([how it works](docs/OFFLINE.md)).
- **Print it as a book.** Fold-and-staple booklet PDFs in A4 and A3 are made from
  the same content ([printing guide](docs/PRINTING.md)). New sets are attached to
  the [Releases](https://github.com/abhijithda/jainism/releases) page when I
  publish them.
- **Ask a question.** An optional AI panel can answer from the book's own content.

## Spotted a mistake, or want something credited or removed?

Please [open an issue](https://github.com/abhijithda/jainism/issues). Photos,
videos and thumbnails from other sources belong to their owners.

## Vision and goals

A Jain Pooja (or confusing Jainism Concepts related to that) F.A.Q.s style based website - where a question would be answered, and then follow-up questions on parts of those answers could be asked. In other words, a topic would be shared, and follow-ups questions will be asked, or more follow-up details will be added emphasizing the points of the previous ones.

The information I've gathered is over-time, and I expect one to follow to similar pattern!!! Not expecting anyone to complete this entire content in one day! But rather keep coming back to read and continue. 
So, I kind of somewhat like to present topics and follow-ups not grouped together, but rather present in interleaved fashion i.e., rather than consolidating similar topics now, I like to keep it spread out. This probably re-emphasizes what was said earlier, and gives times to one to think about it and come back, and/or remember previously discussed points even after changing the topics. I believe this'll kind of help solidify one on those topics.

1. One may like to read in their own language of choice, and/or maybe take printouts in multiple (maybe 2 or 3 ) languages to share it with others.
2. All the reference videos are linked to emphasize the content.
3. Shloka, Mantra, Notes would also accompany.
4. A follow-up question could be actually be referring to 1, 2 or more previous topics asking how can those be happening? (Like, if this is the case, then how can that be?), or a follow-up answer could address multiple items.
5. Part of an answer could be followed up (say when there are multiple points/paras).
6. Same item could be have multiple followups over a period of time.
7. Add in images (and maybe with captions, or maybe few words describing about that). Include stories like Manatunga acharya story that came up as an example to one of the questions. Similarly, there'll be few stories not part of any follow-up, but that later would lead to follow-ups/questions!
8. In future, we may want to create a book out of this content. Maybe, even on web, we can provide a way to read it like a book. (Maybe Manga way (don't mean opposite direction page flipping. Just book format - pages n all)?!)
9. One should be able to take printouts of any view they like. I.e., maybe they like author of the video, so just include thumbnail (along with contents ofcourse), or just QR-code to scan and watch videos, or have both (in PIP format?). Let user choose what they like. Even the web-view can have customization of columns/items that they want to see, so we should have some customization/settings button.
10. The videos will play on youtube (almost every video is from youtube), and users can keep track of what or how much they've watched those videos. And probably good to get into their YT history so that they get recommendations in future ! :) )
11. The content is like going to be static, or not expecting much change. Maybe I'll or a group of people will update. But users of this site are mainly readers.
12. User may want to come back to where they had stopped reading. (Or maybe, provide completed reading option like in hellointerview website?). One could probably authenticate with github or google, or just use browser caching, or maybe both!. 
13. Include timestamps of when it was added. (Helps me at the least).
14. In web-view I should be able to see what's the follow-up for, so an excerpt (that can be expanded in place?) attached to the follow-up in a Whatsapp reply style would be great. (Not talking about Whatsapp theme, colors or styling. Just the reply-excerpt giving the content, and having ability to jump to that context to read more).
15. I also want to include photos/images that are kind of randomly inserted without relevant to a topic (and not attached to a topic, and could be treated as separate topic if required, and could have follow-ups much later!). Some may be like my grandparents or parents photos, and some related to Jain Idols. (Some images will be related to follow-up, but not all of them.)
16. NOTE: The data that was parsed from Google Docs/pdfs is in json format, but the Docs/Pdfs is still not organized. I.e., it starts out randomly. So, the starting point still needs to be updated, and need to add some context - maybe like preface in a book?!. (But those will come much later. Should I say low priority due to time & energy constraints?!)

*A note on printing:* initially I had a print mode that showed only the QR code (no videos), and later removed it so that I can take printouts in different ways to share it with others who need it probably differently. (Older people may not scan QR-code, and may just want to see the thumbnail!)

---

## For developers

Everything above is for readers. The rest of this page is for anyone who wants to
run, test or change the site.

### Highlights

- **No build step.** Plain ES modules in `src/`, served as-is. It is hosted on
  GitHub Pages straight from the repository.
- **Two ways to read.** A paged *Book* view and a *Continuous* view, with a
  Kannada/English language picker, font scaling, paper size, read tracking and
  links that point to a specific block of text.
- **Opt-in offline copy.** A service worker (`sw.js`) crawls the app and the
  pictures itself, so there is no file list to maintain, and online readers
  always get the latest files ([details](docs/OFFLINE.md)).
- **QR codes drawn in the browser.** Our own encoder (`src/core/qr.js`, checked
  against OpenCV's decoder) turns each video link into a QR code, so they work
  offline and print as vector shapes ([details](docs/THUMBNAILS.md)).
- **Real print output.** A GitHub workflow renders six PDFs (Continuous, Book and
  imposed Booklet, each in A4 and A3) with Playwright and pdf-lib, ready to print
  double-sided and fold ([printing guide](docs/PRINTING.md)).
- **Optional AI question panel** (`src/ai/`) that answers from the book's own
  content, with cloud, local and custom engines. The cloud engine goes through a
  Cloudflare Worker (`proxy/`) with rate limits and an exact daily budget
  ([design notes](docs/AI.md), [proxy](proxy/README.md)).
- **Tested.** `assets/data.json` is validated against `assets/schema.json` (Ajv),
  hundreds of Jest unit tests cover the logic, and Playwright end-to-end tests
  include screenshot baselines. CI runs all of it on every push and pull request.

### Run it locally

```bash
npm ci
npx http-server -p 8080      # then open http://localhost:8080/
npm run test:unit            # Jest unit tests
npm test                     # unit tests + Playwright end-to-end tests
```

`npm ci` also installs the Playwright browsers (the `postinstall` script). The
offline copy only works over https or `localhost`.

### Content and scripts

All content lives in `assets/data.json` (questions, answers, follow-ups, videos,
images). Useful commands after changing it:

| Command | What it does |
| --- | --- |
| `npm run thumbs` | Downloads missing video thumbnails into `assets/images/thumbs/` (needs internet) |
| `npm run thumbs:check` | Lists missing thumbnails without using the network |
| `npm run sync:title` | Rewrites the link-preview title in `index.html` after the book title changes |
| `npm run render:prints` | Renders the print PDFs |
| `npm run impose:booklet` | Arranges Book pages in booklet order |

### Project layout

| Path | What it is |
| --- | --- |
| `index.html`, `sw.js` | The page and its service worker (offline use) |
| `src/` | The app: plain ES modules served as-is, no build step |
| `assets/` | `data.json` (the questions and answers), `schema.json`, `images/` |
| `proxy/` | Cloudflare Worker for the optional Cloud AI engine |
| `scripts/` | Print rendering, booklet imposition, id generation |
| `test/` | Unit tests (`test/unit/`) and Playwright tests (`test/e2e/`) |
| `docs/` | Offline, link preview, thumbnails, UI notes, [printing](docs/PRINTING.md), [architecture](docs/AI.md), [requirements](docs/REQUIREMENTS.md): see [More documentation](#more-documentation) |
| `notes/` | Older notes and song texts, kept as source material |

### More documentation

| Page | What it covers |
| --- | --- |
| [docs/OFFLINE.md](docs/OFFLINE.md) | The opt-in offline copy: what the service worker saves, data use, iPhone caveats, resetting while developing |
| [docs/LINK-PREVIEW.md](docs/LINK-PREVIEW.md) | The preview shown when the link is shared, and how to change the book title |
| [docs/THUMBNAILS.md](docs/THUMBNAILS.md) | Video thumbnails and QR codes: adding videos, the unavailable list, print and test order |
| [docs/UI-NOTES.md](docs/UI-NOTES.md) | Layout, media and print rules; how links in text work |
| [docs/PRINTING.md](docs/PRINTING.md) | Making the folded booklet |
| [docs/AI.md](docs/AI.md), [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Architecture and design notes, requirements |

## License

Code: [MIT](LICENSE)

Photos, videos and thumbnails from other sources belong to their owners. If you own something here and want it credited or removed, please open an issue.
