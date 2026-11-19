# Content Pipeline Agent

Status: **built, not yet run on GitHub** (the logic and unit tests run locally; the workflow needs the one-time setup below).

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

## Files

| File | Purpose |
| --- | --- |
| `.github/workflows/content-agent.yml` | Trigger (`staging/**`, only when `assets/data.json` changed), commit, PR, CI dispatch |
| `scripts/content-agent.js` | Pure `processDraft()` plus the CLI |
| `scripts/content-agent.test.js` | 38 unit tests, including runs on the real `data.json` (a re-drafted question and the real follow-up answer `z5xxer`) |
| `scripts/new-id.js` | Unchanged; the agent reuses `fillMissingIds` |
