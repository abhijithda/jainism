# Content Pipeline Agent

Status: **built, not yet run on GitHub.** The logic and the unit tests run locally (the AI and GitHub are faked in the tests,
so nothing here has talked to the real Gemini API or the real Pull Request API yet; see "First run" at the end).

Four jobs, one Pull Request:

| Job | You give | You get |
| --- | --- | --- |
| **Pipeline** (above) | items/blocks without an `id` in `data.json` | ids, timestamps, links, cross-references |
| **1. Notes to blocks** | a `.txt` file in `content-inbox/` | items and blocks in `data.json`, then the pipeline runs |
| **2. Typo review** | nothing (it follows every agent commit) | a second commit with clear typo fixes, one-click suggestions for doubtful ones |
| **3. Video follow-up** | "follow up of A-11.2" + a YouTube link | a new follow-up answer with the video attached, from the transcript |

Jobs 1 to 3 use the Gemini API (free key). The pipeline itself needs no key.

## What it does

You draft new content in `assets/data.json` and push the branch to `staging/<anything>`. The agent:

1. gives every item and block with no `id` a permanent opaque 6-character id (same generator as `scripts/new-id.js`);
2. stamps each brand-new item with a `timestamp` if you did not write one;
3. links a new **answer** that has no `references` to what it answers (you cannot write an id in the draft that does not exist yet):
   - right below a **question**: it references that question, and takes the question's `num`;
   - right below another **answer**: it is a **follow-up / update** to that answer (the book interleaves these, for example
     `z5xxer`, which references three blocks of the answer above it). It references the blocks of that answer it relates
     to most, in the order they appear, and needs its own `num` (see below);
4. finds related earlier content and appends it to the item's `references`, which the app draws as `Ref: A-3.1` strips;
5. commits `assets/data.json` to the same staging branch, opens a Pull Request (or comments on the open one) listing
   everything it did, and starts the CI run.

It never merges, never edits your text, never changes an existing id, `num`, reference or timestamp, and does nothing when
every item already has an id (so it is safe to re-run).

## How you use it

```
# 1. on a branch, add the new Q&A to assets/data.json with NO "id" lines (and a "num" on the question)
git checkout -b staging/panchamruta-questions
git commit -am "Draft: panchamruta questions"
git push -u origin staging/panchamruta-questions

# 2. wait a minute: a Pull Request appears, with the agent's commit on the branch
git pull                      # bring the agent's commit down before you push more

# 3. review the PR description, fix any cross-reference you do not like, check CI, merge
```

A draft item looks like this (no `id`, no `references`, no `timestamp`):

```json
{ "type": "question", "num": 29,
  "blocks": [ { "num": 1, "type": "paragraph",
                "content": { "kn": ["…"], "en": ["Can we do panchamruta abhisheka?"] },
                "tags": ["Panchamruta", "Abhisheka"] } ] },
{ "type": "answer",
  "blocks": [ { "num": 1, "type": "paragraph", "content": { "kn": ["…"], "en": ["…"] }, "tags": ["Abhisheka"] } ] }
```

Run it locally first with `npm run agent:content -- --dry-run` (needs Node 22): prints the report, writes nothing.
Options: `--max-refs 3`, `--min-score 15`, `--follow-up-blocks 2`, `--report out.md`.

## One-time GitHub setup

Repo **Settings → Actions → General → Workflow permissions**: choose *Read and write permissions* and tick
*Allow GitHub Actions to create and approve pull requests*. No secrets, no AI key.

## Follow-up answers

A follow-up answer is written like any other answer, just placed right below the answer it extends:

```json
{ "num": 20, "type": "answer",
  "blocks": [ { "num": 1, "type": "paragraph", "content": { "kn": ["…"], "en": ["Acharya Vidyasagar Swami: …"] } } ] }
```

- The agent adds `references` to the blocks of the answer above that match the follow-up's text and tags (best first, at most
  `--follow-up-blocks`, default 3, the same as `z5xxer`), written in the order they appear in that answer. If no word matches,
  it anchors to that answer's first block, so a follow-up is never left unattached. The PR lists these, so keep only the blocks it
  really builds on.
- It has **no question of its own**, so it cannot take a number the way an answer under a question does: give it a `num`
  (as `z5xxer` has 20). The PR flags it until you do.
- If you write any `references` yourself, the agent leaves them alone and links nothing by position.
- Only the item **directly** above counts. A photo or blank page between the two means the agent will not link them; write the
  `references` yourself in that case.

## How the cross-references are chosen

- The book's own search, `src/ai/retrieval.js` (BM25 over the text of every language plus the tags, with Kannada
  trigrams and the Latin spelling fold). Same input, same result; no network.
- The query is all the new item's text and tags. Candidates are the **best block of each earlier item**.
- Never an insert, never the item itself, never something already in its `references` (including the answer a follow-up
  updates), never a later item
  (a `Ref:` strip points back).
- A match must score at least `--min-score` (default 10) **and** at least 0.6 of the best match; at most
  `--max-refs` (default 2) are added, after any references you wrote yourself.
- The reference is the matched **block** id, so the strip shows the block that actually matched.

Calibration (on this book, 28 questions): re-drafting real Q&As found plausible neighbours, with scores of 15–125.
Short unrelated English queries scored under 7; a short Kannada-only query scored about 14 against unrelated text
(Kannada trigrams are noisy), so a very short Kannada-only draft can get a weak reference. Raise `--min-score` if you
see that, and always read the list in the PR.

## What it does not do

- It does not choose `num`. Numbers are yours (you reorder). It lists items still without one in the PR description,
  and `data.test.js` fails until they are set.
- It adds cross-references only to brand-new **items**, not to new blocks inside an existing item (those only get ids).
- It does not link a new **question** to the answer above it. In the book some questions follow up an answer (they have
  `references`) and some start a new subject (they have none), and nothing in the draft says which. The search still finds
  that answer if it is related; to be sure, write the reference yourself (use the answer's block id if you only mean one block).
- It does not judge meaning. Words and tags match, so "related" can be wrong. The PR is where you catch that.
- A `Ref:` strip changes how the card looks (an excerpt appears above it) and what the AI assistant is given as context
  for that item. Delete a reference you do not want in the PR; nothing else depends on it, except that an answer's
  **first** question reference decides its number.

## Why CI is started by hand

A commit or PR made with the built-in `GITHUB_TOKEN` does not trigger other workflows, so `ci.yml` would never run on the
agent's commit. The workflow therefore dispatches `ci.yml` for the branch (it already has `workflow_dispatch`); the result
shows on the PR. The agent's own commits (by `github-actions[bot]`) are skipped, so it cannot loop.

## Names: branch and inbox folder

- **The branch must start with `staging/`** (for example `staging/abhisheka-notes`; what follows is yours to choose). That prefix is the
  safety fence in `content-agent.yml` (`branches: [ "staging/**" ]`): the agent never runs on `main` or on your feature branches.
  To use another prefix, change that one line (and the branch name in `video-followup.yml`).
- **The notes folder is `content-inbox/`, at the top of the project, not under `assets/`.** `assets/` is what the site itself loads
  (data, images, thumbnails, transcripts) and what the data tests check; a raw `.txt` of notes is a draft, not site content. The
  folder name appears in three places only: the `INBOX` constant in `scripts/notes-to-blocks.js`, `paths:` in `content-agent.yml`,
  and `content-inbox/README.md`.
- **Phone:** on github.com open the branch menu, type `staging/some-name`, choose *Create branch*, then *Add file, Create new file*
  and name it `content-inbox/some-name.txt`. Committing it starts the agent.
- The secret must be called exactly `GEMINI_API_KEY` and be a **repository secret** (Settings, Secrets and variables, Actions, Secrets
  tab; not the Variables tab).

## Job 1: notes to blocks

Put a text file in `content-inbox/` on a `staging/...` branch and push (details: `content-inbox/README.md`). The workflow
runs `scripts/notes-to-blocks.js` first, then the pipeline above, in one commit, and opens the PR.

- **The AI only decides where the text splits** (items, blocks) **and each block's type** (paragraph / shloka / mantra / note),
  by answering with line numbers. **The code copies your lines into the blocks.** Before anything is written,
  `verifyPreservation()` checks that the lines out are exactly the lines in (only these are removed: the `ಪ್ರಶ್ನೆ ಕರ್ತ:` /
  `ಉತ್ತರ:` / `Inquirer:` / `Answer:` prefixes, YouTube links, blank lines, spaces at the edges of a line). It runs again after
  the translation. If it fails nothing is written. A model answer that is not a valid split (a gap, an overlap, a wrong type)
  is retried once, then the rule-based split is used and the PR says so.
- **Items:** with `ಪ್ರಶ್ನೆ ಕರ್ತ:` / `ಉತ್ತರ:` prefixes they decide the items (a question, then its answer). With none (rough notes)
  the default is one **answer** item; the AI starts a second item only when the topic clearly changes (for example the
  Deshabhushana story after the abhisheka notes).
- **Numbers:** a question gets the next free `num`; an answer right below a question takes none (it shares the question's number);
  a note-style answer with no question gets its own next `num`, like a follow-up answer. It is marked so the pipeline does not
  guess it is a follow-up of the answer above (put `followup: yes` in the file header if it is one).
- **Videos:** every YouTube link (`youtu.be`, `watch?v=`, `/shorts/`, `/live/`) becomes a `videos` entry `{ url, youtubeId }` with
  the link as you wrote it, `?t=` included, and leaves the text. A link on its own line goes to the text line above it; a link in
  a line goes to that line. Other links (forms, websites) stay in the text.
- **Language:** each block is in the language you wrote it in (the script with more letters: Latin text, also romanised Hindi,
  counts as English). The other language is **machine-translated line for line** (the count must match; one retry; else it
  is left empty and listed as missing). A language you wrote is never overwritten. Shloka and mantra blocks are
  **transliterated**, not translated, and listed to check against the source.
- **Where:** at the end, or `after: A-11` (also `A-11.2`, `Q-11`, a number, an id) in the file header.
- **The PR lists:** the blocks made (type, language, videos), what was machine-translated ("review this"), missing translations,
  and **suggested tags**. Tags are never written into `data.json`.
- **Thumbnails:** a new video needs `assets/images/thumbs/<id>.jpg` or the data test fails, so the workflow runs
  `fetch-thumbs.js` before it commits.

What the rule-based split does without a key: Example 1 (a Q&A) comes out right (one question; one answer with a block of
the first lines and a block with the Vidyasagar line and its video). Example 2 (rough notes) is only roughly split, because
the rules cannot tell a heading from a point: numbered points get their own block, but "6. ..." then swallows the next heading
and the story into one block. With the key the AI separates them.

## Job 2: typo review (a second commit)

`.github/workflows/typo-review.yml` is started by the content-agent workflow after its commit (a push by the built-in token
does not start workflows by itself), or by hand: Actions, *Typo Review*, Run workflow, with the branch name (tick
`whole_book` to check everything). It reviews only the blocks the branch **adds or changes** compared with the main branch.

| Finding | What happens |
| --- | --- |
| Clear typo in plain prose (paragraph / note) | fixed in **one commit** (`typo-review: fix N clear typo(s)...`); revert that commit to undo all; listed old, new, reason |
| Doubtful case | **not changed**; a *Commit suggestion* button on that line of the PR |
| Kannada-script words inside an English line (your own mixed notes) | written in Latin letters **automatically only if** the model says clear, scores it 0.9 or more, **and** a second call turning the Latin back into Kannada gives your word, counting the letters in `config/translit-equivalents.txt` as the same (ಣ = ನ, ಲ = ಳ, ಸ = ಶ = ಷ, vowel length, the ಾ sign; edit that file as you like); otherwise a *Commit suggestion* |
| A Kannada word next to the same English word (`ಣವಣ / Navana`, also several words: `ಉಪ ಲೇಪನ / Upa Lepana`) | one version is kept, in your spelling (`Navana`, `Upa Lepana`), when the converted words are the same; a different spelling stays as a pair. The same English word typed twice by you (`Navana / Navana`) is only a suggestion |
| Final "a" of Sanskrit words | the book's style is `abhisheka`, `Rama`, not the Hindi `abhishek`, `Ram`. Every prompt that writes English says so, and where the Kannada word is known the code puts a dropped final "a" back |
| Invisible characters (word joiner, zero-width space, BOM) from copy-paste | removed automatically (the joiners Kannada conjuncts need are kept) |
| Shloka / mantra block | **never changed**, never suggested; listed under "check against the source" |
| A spelling in `config/spelling-allowlist.txt` | never flagged, never changed |

The AI only proposes `{ old, new, reason, confidence }`; the code decides. A fix is automatic only if the model said clear,
`old` occurs **once** in the line, is short, differs from `new` by at most 3 letters (2 in Kannada), and does not overlap
the allowlist or a link. Anything else is a suggestion at most. The only fixes that need no AI are a double space and invisible characters. Without the key
only that runs, and the comment says the AI check was skipped. Re-running updates the PR comment and does not repeat
a suggestion that is already there.

`config/spelling-allowlist.txt`: one spelling per line (Poojyapaada, ತೀರ್ಥಕರ, ...). Case does not matter for Latin letters.
Add yours there; the model is also told not to touch them.

## Job 3: video follow-up

Actions, *Video Follow-up*, Run workflow (works from the phone). You give the **target block** (`A-11.2`), a **public YouTube
link**, optionally **start** and **duration** (`12m30s`, `1:20:30`, `5m`, `90s`; a bare number is seconds) and the **speaker**.
**`dry_run` is ticked by default**: it shows the transcript and the points in the run summary and changes nothing. **Try your
first video that way.**

1. The target block, its answer and the question it replies to are read as context.
2. Call 1 gives Gemini the public YouTube link and the clip offsets and asks for a timestamped transcript of the clip.
3. Call 2 (text only) gets the transcript and the context and returns the points that **add** to A-11.2, each with the numbers of
   the transcript lines it comes from, plus the lines where the speaker recites Sanskrit/Prakrit. A point with no valid
   transcript line behind it is dropped (and listed).
4. One new **answer** is placed right below the answer it extends: `references: [the A-11.2 block]`, its own next `num`, a
   paragraph block with the speaker line and the points (English and Kannada, both machine-written) and the video attached at
   the clip start (`?t=`). If there was a recitation, a **note** block says "machine-transcribed, verify against the source" and
   holds the lines exactly as transcribed. **Machine-transcribed Sanskrit/Prakrit is never put in a shloka block.**
5. The PR shows each point with the transcript excerpt it came from and a timestamp link to that second of the video.

Honest limits:
- **Kannada transcript quality is unknown until you try it**; that is why dry run comes first.
- **Clip times:** Google's documentation and users disagree on two things, so both are handled: whether returned timestamps count from
  the video start or the clip start (the code detects it and the report says which it saw), and whether the audio is really cut
  to the clip (a forum report says that for YouTube links the whole audio may still be processed and counted, so give a
  duration and watch your daily quota).
- **Free tier:** public videos only (not private or unlisted), at most 8 hours of YouTube per day. On Google's free tier your prompts
  and the model's answers may be used to improve Google's products (check the current terms before sending anything you consider
  private; this site's content and public videos are not private).
- The points are paraphrases of what the speaker said: a draft to check, never a source.

## Hindi (third language)

Decided: Hindi is a third language, `hi`, in `data.json` and the app, **written in Devanagari**. A reader of Latin-letter Hindi
can mostly read English, so Latin-letter Hindi would add little.

- **Reader chooses at most two languages** (Settings, language picker): a main language and one to compare with, for example
  Kannada + English (the default), Kannada + Hindi, or English + Hindi. With two chosen the other rows are disabled until one
  is unchecked. Saved settings with more than two are cut to two.
- **What is on screen is what is printed**: language, QR and video switches all follow the screen, so there is no per-language
  print list to maintain.
- **Adding a language** (Tamil later): one entry in `src/core/langs.js`, the text in `data.json` (`content.ta`, optional per
  block), a font if the browser has none, and the CSS lines for `.col-ta`, `.book-lang-line.lang-ta` and
  `.title-style-text-line.lang-ta`. The picker and views read the registry.
- `assets/schema.json`: `content.hi` and `caption.hi` are optional; `kn` and `en` stay required.

Not done yet (agent side): detecting Hindi written in Latin letters in a note, converting it to Devanagari (machine, listed in
the PR as unreviewed), keeping it out of typo review, and the follow-up job writing it. Until then such a sentence still
counts as English and the Kannada is machine-translated from it.

Known gaps in the app: the cover title is still Kannada + English only; a reader who picks only Hindi sees blank rows for blocks
that have no Hindi yet.

## Setup for jobs 1 to 3

1. A free key from Google AI Studio, saved as the repository secret `GEMINI_API_KEY` (Settings, Secrets and variables, Actions).
2. Optional: repository variable `GEMINI_MODELS`, a comma-separated list in order of preference, for example
   `gemini-3.8-flash,<a second model>`. The first is used. If it stays busy after its retries, its quota is used up (HTTP 429)
   or the key cannot use it (404), the next one is tried and the rest of the run keeps using the one that answered. Each model
   has its own free-tier quota, so a second model is also a second quota. Names are used exactly as written (the code does not
   know which exist), so check them in Google AI Studio. `GEMINI_MODEL` (one name) still works when `GEMINI_MODELS` is empty.
   The default in `scripts/lib/gemini.js` is a model name taken from Google's documentation, which renames and retires models
   often, so if every call fails with a 404 or 400 naming the model, this is the first thing to change.
3. Optional: repository variable `GEMINI_THINKING_LEVEL` (`minimal`, `low`, `medium` or `high`), sent as
   `generationConfig.thinkingConfig.thinkingLevel`. Unset sends nothing (the model's own default). Gemini 3 models think before
   they answer, and those tokens count and take time even for a tiny answer. Look at the log first: every call prints
   `[gemini] call 3: in 1200, out 310, thinking 2950, total 4460 tokens, 12.4s` and each script ends with a totals line. If
   thinking is most of the total and the answers are fine, set `low` (or `minimal`) and compare the next run. If the model
   rejects the setting (HTTP 400 naming thinking) the call is repeated without it and the log says so. Gemini 2.5 models use
   `GEMINI_THINKING_BUDGET` (a number of tokens) instead; never set both.
4. The permissions from "One-time GitHub setup" above (workflow read and write, allow Actions to create pull requests).

## First run: what has not been seen working

Tested here, with fakes: every rule above, both of your examples, the whole path to the existing pipeline, the PR suggestion
payload. **Not tested** (no network access to Gemini or GitHub from where this was built): the real Gemini answers (split,
translation, typos, transcript), the workflows on GitHub, and that GitHub accepts each suggestion line. Suggested order: run
Notes with Example 1, then Example 2; run Video Follow-up as a dry run on a video you know; then the typo review on a
branch that has a typo you know about.

## Files

| File | Purpose |
| --- | --- |
| `.github/workflows/content-agent.yml` | Trigger (`staging/**`, when `assets/data.json` or a `content-inbox/*.txt` changed): notes, pipeline, thumbnails, commit, PR, CI, typo review |
| `.github/workflows/typo-review.yml` | The second commit and the PR suggestions |
| `.github/workflows/video-followup.yml` | The "Run workflow" form for job 3 |
| `scripts/content-agent.js` | Pure `processDraft()` plus the CLI (now also removes the `_agent` marker notes-to-blocks leaves) |
| `scripts/notes-to-blocks.js` | Job 1 |
| `scripts/typo-review.js`, `scripts/post-suggestions.js` | Job 2 and the PR suggestion poster |
| `scripts/video-followup.js` | Job 3 |
| `scripts/lib/book.js` | A-11.2 labels and places (same rules as `src/core/blocks.js`, checked against it in a test) |
| `scripts/lib/youtube.js`, `scripts/lib/gemini.js` | YouTube link parsing; the small Gemini client |
| `scripts/*.test.js`, `scripts/lib/lib.test.js` | 38 + 32 + 24 + 16 + 14 unit tests (the AI and GitHub are fakes) |
| `scripts/fixtures/notes-example-*.txt` | Your two Google Doc examples, verbatim, used by the tests |
| `config/spelling-allowlist.txt` | Your intentional spellings |
| `content-inbox/` | Where notes files go (processed files move to `content-inbox/done/`) |
| `scripts/new-id.js` | Unchanged; the agent reuses `fillMissingIds` |

### Pairs like `ಣವಣ / Navana` in the translation step

When you type a Kannada word and its Latin spelling together, the machine translation keeps only your own word in the other
language: the Kannada translation keeps `ಣವಣ` (never adds a second spelling `ನವಣ`), and the English translation has only
`Navana` (never Kannada letters). The model is told this, and code checks it afterwards (it removes at most one extra word, so
nothing else in the line is lost). The typo review's report always says how many English lines had Kannada words and how many
changes the model proposed, so an empty result is visible.

### When Gemini is down

A call that gets HTTP 429, 5xx or a timeout is tried again a few times with growing pauses (then the next model in
`GEMINI_MODELS`, if any). If every model stays busy, the run stops asking Gemini at all, so an outage costs minutes, not the
nine minutes one run took.

- **Notes to blocks stops and changes nothing**: `data.json` is as it was, no block is added, and every note stays in
  `content-inbox/` (it moves to `done/` only after `data.json` is written). The step exits with code 2 and says so. When Gemini
  is back: Actions, Content Agent, **Re-run jobs**. This is on purpose: a split by rules and missing translations would put
  half-finished blocks into the PR.
- A Gemini answer that arrives but is not usable (bad JSON, wrong number of lines) is different: the rule-based split is used
  and missing translations are listed, as before.
- Typo review and video follow-up do not insert items, so an outage there only means no AI help for that run (typo review still
  makes its mechanical fixes).

### Typos are matched as whole words

A fix or one-click suggestion is placed on the word itself, never on the first letters of a longer word: `chandan → chandana`
in a line that already says `chandana` earlier is applied to the standalone `chandan`, not to the start of the first
`chandana` (which once made `chandanaa`). A word that only appears inside longer words is left alone. Spans that carry their own
neighbouring characters (double spaces, invisible characters) are matched as written.

The same typo several times in one line is fixed everywhere in that line in one run (the report says "N places in this line"; a
one-click suggestion also changes every place), so ten identical typos never mean ten runs. A protected spelling (allowlist or link) in
any of the places stops the change.

### Typo review: what is never fixed automatically

- Kannada: a change that only swaps a short vowel sign for its long one or back (`ಬಂದರು` / `ಬಂದರೂ`) is a suggestion, never an automatic fix,
  because both spellings can be real words with different meanings. The suggestion says why.
- When part of the AI check fails (for example HTTP 429 on the last part), the report says how many parts were not checked and
  names the first blocks (`not checked: A-5.1, ...`), so you know what to check by hand or run again.

