# content-inbox: rough notes in, items and blocks out

1. Make a branch whose name starts with `staging/` and put one `.txt` file here (any file name):

```
git checkout -b staging/jaya-dhavala-abhisheka
# save the notes as content-inbox/jaya-dhavala.txt
git add content-inbox/jaya-dhavala.txt
git commit -m "Draft: Jaya Dhavala abhisheka notes"
git push -u origin staging/jaya-dhavala-abhisheka
```

2. A minute later a Pull Request appears. The content agent has turned the notes into items and blocks in `assets/data.json`
   (the file moves to `content-inbox/done/`), added ids, timestamps and cross-references, and listed in the PR what to review:
   machine translations, missing translations, suggested tags. A second commit with typo fixes follows.
3. `git pull`, review, fix what you want, merge. The agent never merges.

Paste the text exactly as it is in your Google Doc. Write in one language (Kannada or English); the other is machine-translated.
Q/A prefixes (`ಪ್ರಶ್ನೆ ಕರ್ತ:`, `ಉತ್ತರ:`, `Inquirer:`, `Answer:`) are dropped and decide the items. YouTube links anywhere in the text
become `videos` (a `?t=` start time is kept) and leave the text. **Your wording is never changed.**

## Optional header

The first lines can set where the items go and how to read the text. The header is not part of the notes:

```
---
after: A-11
lang: kn
followup: yes
---
ಉತ್ತರ: ...
```

| Key | Meaning |
| --- | --- |
| `after` | Put the items right after this place: an id, `A-11.2`, `A-11`, `Q-11` or a number. Default: the end of `data.json`. |
| `lang` | `kn` or `en`: treat every block as written in that language (default: decided per block from the script). |
| `followup` | `yes`: a note-style answer is a follow-up of the answer right above it (it will reference that answer's blocks). Default: not. |

New items always get the next free `num` (renumber as you like afterwards).

Run locally to see what would happen, without writing anything: `npm run agent:notes -- content-inbox/x.txt --dry-run`
(add `--no-ai` to skip the Gemini calls).
