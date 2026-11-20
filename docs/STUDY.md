# Study companion

Turn it on in **Settings → 🎓 Study companion** (also on Home). It is off by default.
Turning it on also turns on **Read tracking**, because the questions follow the ✓ ticks.

> Not to be confused with the **⛶ Focus** button in the header: that one is zen mode
> (hides the header). The study companion is called *Study* everywhere to keep the two apart.

## What the reader sees

1. They mark a section as read (the ✓ at its corner).
2. A small green chip appears bottom-left: "🎓 Test yourself: Deva Moodhata vs Loka Moodhata".
   It only offers. It never opens the panel by itself, so reading (and book pagination) is not
   interrupted. It disappears after 15 seconds or when dismissed.
3. The **🎓 Study** button (header) opens a slide-over panel with the questions, e.g.
   *"You just read about Deva Moodhata. Can you explain how it differs from Loka Moodhata?"*
4. The reader types an answer (optional), taps **Show what the book says** and sees the
   book's own passages, word for word, each with a chip that opens it in the book.
5. **I got it ✓** removes the question and it is not asked again. **Review later ↻** keeps
   it in a "To review" list at the bottom of the panel, to **Practise again**.

Nothing is marked, scored or sent anywhere by the reader's own answer: it is for them to compare
with the passages. (With AI on, see below.)

## Where questions come from (no AI needed)

`src/study/study-questions.js`, using only `data.json`:

| Kind | When | Built from |
| --- | --- | --- |
| **Compare** | A block with a multi-word tag is marked read | Siblings of the tag: other tags ending in the same word (Nishchaya Naya / Vyavahara Naya), plus phrases of the same shape that the English text names without tagging them, **only if some block names them together with the topic** (the Moodhata note lists Deva, Loka and Guru together, so Loka Moodhata qualifies; a stray capitalised word does not). Spelling variants (Samyag / Samyak) are ignored. |
| **Recall** | Every readable block of an *answer* is marked read | The question the answer replies to (`references`), then the answer's own blocks |

Rule: a question is only offered if the book has passages for **both** sides (every word of the
topic must appear in the passage). It never asks what the book doesn't cover.

Adding content: nothing to do. Tag new blocks consistently (e.g. "Loka Moodhata" as a tag would make it a
tag sibling) and the questions follow. Multi-word tags that end in a shared word are what create comparisons.

## Optional AI (Settings → AI assistant: Cloud)

Only when a **hosted** engine is usable (this site's Cloud assistant or the reader's own service):

* **✨ Another question from the AI**: writes one question from the passage just read and its related
  passages. Shown only if its model answer cites a real passage.
* **Check my answer (AI)**: short feedback on the reader's answer. Shown only if it cites a real passage;
  otherwise the passages are shown instead.

Both are **on request**, never automatic, so a busy reader cannot use up the Cloud assistant's daily budget.
The on-device (Local) models are **not** used for these: the assistant's docs record small models
reversing a passage's meaning, and a wrong "you got it right" is worse than no feedback.
What is sent: the reader's answer (for a check) and the passages. The buttons' tooltips say so.

## Files

| File | Role |
| --- | --- |
| `src/study/study-questions.js` | Pure: topic model, comparisons, question building |
| `src/study/study-log.js` | What the reader answered (localStorage `studyLog`: ids and "got"/"again" only, no book text) |
| `src/study/study-ai.js` | Prompts and validation for the optional AI parts |
| `src/study/study-panel.js` / `.css` | Button, nudge, panel, setting; reuses the assistant drawer's look |
| `src/core/read-tick.js` | Fires `pooja:block-read` (`{blockId, read}`) on every tick click |
| `src/core/settings.js` | `studyCompanion` (boolean, default false) |

Panel state (open, pending questions) survives a reload in `sessionStorage` (this tab only).
The panel is an overlay and is never printed.

## Tests

* Unit: `src/study/*.test.js`, `src/core/read-tick.test.js` (event)
* e2e: `test/e2e/core/study-companion.test.js` (both views, reload, phone width, print)
