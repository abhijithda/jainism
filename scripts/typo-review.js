#!/usr/bin/env node
// typo-review.js — the typo review, run as its OWN commit after the content agent's commit.
//
// What it looks at: only the blocks this branch adds or changes compared with the main branch (--base), unless you pass
// --all. What it does with each finding:
//
//   clear typo in plain prose (paragraph / note)   fixed in data.json, listed in the report as old -> new, reason
//   doubtful case                                  NOT changed: becomes a one-click "Commit suggestion" on that line
//                                                  of the Pull Request (scripts/post-suggestions.js posts them)
//   shloka and mantra blocks                       never changed, never suggested: listed as "check against the source"
//   anything in config/spelling-allowlist.txt      never flagged, never changed
//   Kannada letters inside an English line         (your own mixed-language notes, e.g. "5. ಚುಹಾವಣ : Similar to Upa lepana...")
//                                                  written in Latin letters AUTOMATICALLY when the model is sure (it says "clear", its
//                                                  score is at least 0.9 AND the Latin word, turned back into Kannada by a second call,
//                                                  gives your word, counting the letters in config/translit-equivalents.txt as the same,
//                                                  e.g. ಣ = ನ); anything less is a one-click suggestion
//   invisible characters (word joiner, zero-width space, BOM) pasted from Google Docs / WhatsApp: removed (ZWJ/ZWNJ are kept: Kannada needs them)
//
// The AI only PROPOSES { old, new, reason, confidence }; this code decides what is clear. A fix is applied automatically
// only when `old` occurs exactly once in the line, is short, differs from `new` by at most a few letters (2 in Kannada,
// where the model is less reliable), does not touch an allowlisted spelling or a link, and the model said "clear".
// Everything else, including any Sanskrit/Prakrit looking word, is a suggestion at most.
//
// Without GEMINI_API_KEY only the mechanical fix (double spaces) runs, and the report says the AI check was skipped.
//
//   node scripts/typo-review.js --base base.json            review what differs from base.json
//   node scripts/typo-review.js --all --dry-run             review the whole book, write nothing
//   options: --report out.md  --suggestions out.json  --allowlist file  --data file  --no-ai  --mixed-auto-min 0.9
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createGemini } = require('./lib/gemini');
const { allBlocks } = require('./lib/book');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'assets', 'data.json');
const ALLOWLIST_PATH = path.join(ROOT, 'config', 'spelling-allowlist.txt');
const EQUIVALENTS_PATH = path.join(ROOT, 'config', 'translit-equivalents.txt');
const PROSE = new Set(['paragraph', 'note']);
const VERSE = new Set(['shloka', 'mantra']);
const LANGS = ['kn', 'en'];
const MAX_EDIT = { kn: 2, en: 3 };
const MIXED_AUTO_MIN = 0.9;     // score the model must give for a Kannada-to-Latin change to be automatic

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────

const nfc = (s) => String(s).normalize('NFC');

function loadAllowlist(text) {
    return String(text || '').split(/\r?\n/).map((l) => nfc(l).trim()).filter((l) => l && !l.startsWith('#'));
}

/** Edit distance over code points (so a Kannada letter with its vowel sign counts as two, as it is typed). */
function editDistance(a, b) {
    const x = [...a], y = [...b];
    let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
        const cur = [i];
        for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[y.length];
}

/** All [start, end) spans of `needle` in `line` (Latin letters compared without case). */
function spansOf(line, needle, ignoreCase = true) {
    const out = [];
    const hay = ignoreCase ? line.toLowerCase() : line;
    const n = ignoreCase ? needle.toLowerCase() : needle;
    if (!n) return out;
    for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) out.push([i, i + n.length]);
    return out;
}
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

/** Is the span of `old` in this line inside an allowlisted spelling, or inside a link? */
function protectedSpan(line, span, allowlist) {
    for (const entry of allowlist) if (spansOf(line, entry).some((s) => overlaps(s, span))) return true;
    for (const m of line.matchAll(/https?:\/\/\S+/g)) if (overlaps([m.index, m.index + m[0].length], span)) return true;
    return false;
}

// ── what to review ─────────────────────────────────────────────────────────────────────────────────────────

/** Blocks that are new or whose text differs from `base` (a parsed data.json), or every block with `all`. */
function changedBlocks(base, head, { all = false } = {}) {
    const before = new Map();
    for (const item of base || []) for (const b of item.blocks || []) before.set(b.id, JSON.stringify(b.content || {}));
    return allBlocks(head).filter(({ block }) => all || before.get(block.id) !== JSON.stringify(block.content || {}));
}

/** The lines to check: [{ key, blockId, label, lang, index, text, kind: 'prose'|'verse' }] */
function collectLines(entries) {
    const out = [];
    for (const { block, label } of entries) {
        const kind = VERSE.has(block.type) ? 'verse' : 'prose';
        for (const lang of LANGS) {
            (block.content?.[lang] || []).forEach((text, index) => {
                if (String(text).trim()) out.push({ key: `${block.id}|${lang}|${index}`, blockId: block.id, label, lang, index, text, kind });
            });
        }
    }
    return out;
}

// ── the mechanical fix and the AI proposals ─────────────────────────────────────────────────────────────────

/** Fixes that need no judgement: runs of spaces inside a line. Returns the proposals in the same shape as the AI's. */
function mechanicalIssues(line) {
    const out = [];
    // invisible junk from copy-paste; U+200C / U+200D (ZWNJ / ZWJ) are NOT touched, Kannada conjuncts need them
    for (const m of line.text.matchAll(/[\u2060\u200B\uFEFF]/g)) {
        const i = m.index;
        const old = i + 1 < line.text.length ? line.text.slice(i, i + 2) : line.text.slice(i - 1, i + 1);
        out.push({ key: line.key, old, new: old.replace(/[\u2060\u200B\uFEFF]/g, ''), reason: 'invisible character', confidence: 'clear' });
    }
    for (const m of line.text.matchAll(/\S( {2,})\S/g)) out.push({ key: line.key, old: m[0], new: m[0][0] + ' ' + m[0][m[0].length - 1], reason: 'double space', confidence: 'clear' });
    return out;
}

const TYPO_SYSTEM = `You proofread lines from a Jainism Q&A book written in Kannada and English by a non-professional writer. Find clear typing mistakes only.
Return JSON only: {"issues":[{"key":"...","old":"exact text from the line","new":"corrected text","reason":"short reason","confidence":"clear"|"doubtful"}]}.
Rules:
- "old" must be copied exactly from the line and be as short as possible (one word, or a few words), "new" is that same piece corrected.
- Report only spelling and typing mistakes: a wrong, missing or extra letter or vowel sign, a broken conjunct, a doubled word, a missing space between words, a space before a comma or full stop. Never rephrase, restyle, shorten, add words or fix grammar or facts.
- Different valid spellings or transliterations are NOT mistakes (Pooja/Puja, Kundakunda/Kundkund, ತೀರ್ಥಕರ/ತೀರ್ಥಂಕರ, aa/a, v/w). Do not report them.
- "clear" = you are certain it is a typing slip in ordinary Kannada or English prose. Use "doubtful" for anything else: Sanskrit or Prakrit words, quotations, proper names, transliterations, anything where you would want to see the source.
- Lines with "kind":"verse" are shlokas or mantras: report a suspicion as "doubtful" only; they are never corrected automatically.
- Never touch these intentional spellings: `;

/** Ask the model about every line (in chunks). Returns the raw proposals plus a note if the check could not run. */
async function aiIssues(ai, lines, allowlist) {
    if (!ai || !ai.available) return { issues: [], note: 'the AI check was skipped (no GEMINI_API_KEY); only mechanical fixes ran' };
    const issues = [];
    const failures = [];
    const chunkSize = 60;
    for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize);
        try {
            const answer = await ai.json({
                system: TYPO_SYSTEM + (allowlist.length ? allowlist.join(', ') : '(none)'),
                prompt: JSON.stringify({ lines: chunk.map((l) => ({ key: l.key, lang: l.lang, kind: l.kind, text: l.text })) }),
            });
            for (const x of Array.isArray(answer.issues) ? answer.issues : []) issues.push(x);
        } catch (e) { failures.push(e.message); }
    }
    return { issues, note: failures.length ? `the AI check failed for part of the text: ${failures[0]}` : '' };
}

const KANNADA_LETTER = /[\u0C80-\u0CFF]/;

const MIXED_SYSTEM = `These lines are English text from a Jainism Q&A book. The writer put some Prakrit/Sanskrit terms in Kannada script inside the English line.
For every word or phrase in Kannada script, give the same word in Latin letters, in the simple style the book uses for Jain terms (ಚುಹಾವಣ -> Chuhavana, ಪುಷ್ಪಾರೋಹಣ -> Pushparohana, ಣವಣ -> Navana, ಉಪ ಲೇಪನ -> Upa Lepana). This is transliteration (same sounds, Latin letters), not translation. Keep capitalisation natural: capitalise a term that starts a heading or a sentence.
Return JSON only: {"issues":[{"key":"...","old":"the Kannada-script words exactly as in the line","new":"the Latin-letter version","reason":"short","confidence":"clear"|"doubtful","score":0.0-1.0}]}.
"clear" with a high score only when you are sure of every letter (a known term, or a plain word). Use "doubtful" or a low score when the spelling could vary: retroflex ಣ/ನ, ಳ/ಲ, aspirated or long vowels, a term you do not recognise, a damaged or misspelt word.
Do not change anything else in the line. If a Kannada-script word sits next to its own English equivalent ("ಣವಣ / Navana"), still transliterate it; do not drop it.`;

const MIXED_BACK_SYSTEM = `Each item is a Jain term written in Latin letters (Prakrit/Sanskrit/Kannada origin). Write each one back in Kannada script, as it would normally be written.
Return JSON only: {"items":[{"id":"...","kannada":"..."}]}. One answer for every id, nothing else.`;

/** config/translit-equivalents.txt: classes of Kannada letters treated as the same, and signs to ignore. */
function loadEquivalents(text) {
    const map = new Map();
    const drop = new Set();
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').normalize('NFC').trim();
        if (!line) continue;
        if (/^drop:/i.test(line)) { for (const ch of line.replace(/^drop:/i, '').trim().split(/\s+/).filter(Boolean)) drop.add(ch); continue; }
        const [rep, ...others] = line.split(/\s+/);
        for (const ch of others) map.set(ch, rep);
    }
    return { map, drop };
}

/** For comparing a word with its round trip: no spaces, joiners or punctuation, composed form, and (with a list) equivalent letters made equal. */
const skeleton = (t, eq) => {
    let out = String(t).normalize('NFC').replace(/[\s\u200C\u200D.,;:!?()\-\/"']/g, '');
    if (eq) out = [...out].filter((ch) => !eq.drop.has(ch)).map((ch) => eq.map.get(ch) || ch).join('');
    return out;
};

/**
 * English lines that contain Kannada script (prose only). Each Kannada word gets a Latin version from the model, then a
 * SECOND call turns the Latin back into Kannada. A change is marked `mixedAuto` (applied automatically) only if the model said
 * "clear", gave a score of at least `autoMin`, AND the round trip gives exactly the original word. Everything else is a suggestion.
 */
async function mixedScriptIssues(ai, lines, allowlist, autoMin = MIXED_AUTO_MIN, equivalents = null) {
    const mixed = lines.filter((l) => l.kind === 'prose' && l.lang === 'en' && KANNADA_LETTER.test(l.text));
    if (!mixed.length || !ai || !ai.available) return { issues: [], found: mixed.length, note: '' };
    const proposals = [];
    const failures = [];
    for (let i = 0; i < mixed.length; i += 40) {
        const chunk = mixed.slice(i, i + 40);
        try {
            const answer = await ai.json({
                system: `${MIXED_SYSTEM}\nNever touch these intentional spellings: ${allowlist.length ? allowlist.join(', ') : '(none)'}`,
                prompt: JSON.stringify({ lines: chunk.map((l) => ({ key: l.key, text: l.text })) }),
            });
            for (const x of Array.isArray(answer.issues) ? answer.issues : []) {
                if (x && chunk.some((l) => l.key === x.key) && typeof x.old === 'string' && KANNADA_LETTER.test(x.old) && typeof x.new === 'string' && x.new.trim() && !KANNADA_LETTER.test(x.new)) proposals.push(x);
            }
        } catch (e) { failures.push(e.message); }
    }
    // the round trip: Latin back to Kannada must give the writer's own word
    const back = new Map();
    for (let i = 0; i < proposals.length; i += 60) {
        const chunk = proposals.slice(i, i + 60);
        try {
            const answer = await ai.json({ system: MIXED_BACK_SYSTEM, prompt: JSON.stringify({ items: chunk.map((x, k) => ({ id: String(i + k), latin: x.new })) }) });
            for (const it of Array.isArray(answer.items) ? answer.items : []) back.set(String(it.id), String(it.kannada || ''));
        } catch (e) { failures.push(e.message); }
    }
    const issues = proposals.map((x, i) => {
        const score = Number(x.score);
        const got = back.get(String(i));
        const exact = got !== undefined && skeleton(got) === skeleton(x.old);
        const roundTrip = got !== undefined && skeleton(got, equivalents) === skeleton(x.old, equivalents);
        const auto = x.confidence === 'clear' && score >= autoMin && roundTrip;
        const why = roundTrip ? '' : got !== undefined ? ` (turned back into Kannada it gives ${got}, not your spelling)` : ' (round trip not checked)';
        const ok = exact ? ', round trip matches' : ', round trip matches apart from letters your equivalence list treats as the same';
        return { ...x, mixed: true, mixedAuto: auto, confidence: auto ? 'clear' : 'doubtful', reason: `Kannada script in English text${auto ? ` → Latin letters${ok}` : why}` };
    });
    return { issues, found: mixed.length, note: failures.length ? `the Kannada-in-English check failed in part: ${failures[0]}` : '' };
}

// ── deciding ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sort every proposal into: fixes (applied), suggestions (one-click), flags (verse), dropped (with the reason).
 * Pure: takes the lines, the proposals and the allowlist.
 */
function decide(lines, proposals, allowlist) {
    const lineByKey = new Map(lines.map((l) => [l.key, l]));
    const decided = { fixes: [], suggestions: [], flags: [], dropped: [] };
    const seen = new Set();
    for (const p of proposals) {
        const line = lineByKey.get(p && p.key);
        const drop = (why) => decided.dropped.push({ key: p && p.key, old: p && p.old, why });
        if (!line) { drop('unknown line'); continue; }
        if (typeof p.old !== 'string' || typeof p.new !== 'string' || !p.old || p.old === p.new) { drop('not a change'); continue; }
        if (/[\r\n]|https?:\/\//.test(p.new)) { drop('unsafe replacement'); continue; }
        const dedupe = `${p.key}|${p.old}|${p.new}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const spans = spansOf(line.text, p.old, false);
        if (!spans.length) { drop('the text is not in the line'); continue; }
        if (spans.some((s) => protectedSpan(line.text, s, allowlist))) { drop('allowlisted spelling or link'); continue; }
        const base = { key: p.key, blockId: line.blockId, label: line.label, lang: line.lang, index: line.index, old: p.old, new: p.new, reason: String(p.reason || '').slice(0, 160) };
        if (line.kind === 'verse') { decided.flags.push({ ...base, flag: true }); continue; }
        const clear = p.mixed
            ? Boolean(p.mixedAuto) && spans.length === 1                       // Kannada to Latin: its own checks are in mixedScriptIssues
            : p.confidence === 'clear' && spans.length === 1 && [...p.old].length <= 40 && editDistance(p.old, p.new) <= MAX_EDIT[line.lang];
        (clear ? decided.fixes : decided.suggestions).push(base);
    }
    return decided;
}

/** Apply replacements to one line, right to left, skipping any that overlaps one already applied. Returns { text, applied, left }. */
function applyToLine(text, changes) {
    const located = changes.map((c) => ({ c, at: text.indexOf(c.old) })).filter((x) => x.at >= 0).sort((a, b) => b.at - a.at);
    let out = text;
    let limit = Infinity;
    const applied = [], left = changes.filter((c) => text.indexOf(c.old) < 0);
    for (const { c, at } of located) {
        if (at + c.old.length > limit) { left.push(c); continue; }
        out = out.slice(0, at) + c.new + out.slice(at + c.old.length);
        limit = at;
        applied.push(c);
    }
    return { text: out, applied, left };
}

/** New data with the fixes applied (only those lines change), and the suggestions rewritten against the fixed text. */
function applyFixes(data, decided) {
    const next = JSON.parse(JSON.stringify(data));
    const blocks = Object.fromEntries(next.flatMap((i) => (i.blocks || []).map((b) => [b.id, b])));
    const grouped = new Map();
    for (const f of decided.fixes) {
        const k = `${f.blockId}|${f.lang}|${f.index}`;
        grouped.set(k, [...(grouped.get(k) || []), f]);
    }
    const applied = [], notApplied = [];
    for (const [k, changes] of grouped) {
        const [blockId, lang, index] = k.split('|');
        const arr = blocks[blockId].content[lang];
        const r = applyToLine(arr[index], changes);
        arr[index] = r.text;
        applied.push(...r.applied);
        notApplied.push(...r.left);
    }
    // a suggestion whose old text a fix already changed is dropped; the rest stay valid against the fixed line
    const suggestions = decided.suggestions.filter((s) => (blocks[s.blockId].content[s.lang][s.index] || '').includes(s.old));
    return { data: next, applied, suggestions, notApplied };
}

/** GitHub review-comment bodies for the suggestions: one per line of data.json (several fixes to one line are merged). */
function buildSuggestionComments(data, suggestions, filePath = 'assets/data.json') {
    const lines = JSON.stringify(data, null, 2).split('\n');
    const byLine = new Map();
    for (const s of suggestions) {
        const idLine = lines.findIndex((l) => l.trim() === `"id": ${JSON.stringify(s.blockId)},`);
        if (idLine < 0) continue;
        const block = data.flatMap((i) => i.blocks || []).find((b) => b.id === s.blockId);
        const current = block.content[s.lang][s.index];
        const target = lines.findIndex((l, i) => i > idLine && l.trim().replace(/,$/, '') === JSON.stringify(current));
        if (target < 0) continue;
        byLine.set(target, [...(byLine.get(target) || []), { s, current }]);
    }
    const comments = [];
    for (const [target, group] of byLine) {
        const r = applyToLine(group[0].current, group.map((g) => g.s));
        if (!r.applied.length) continue;
        const original = lines[target];
        const indent = original.match(/^\s*/)[0];
        const comma = original.trimEnd().endsWith(',') ? ',' : '';
        const hash = crypto.createHash('sha1').update(r.applied.map((a) => `${a.blockId}|${a.old}|${a.new}`).join('\n')).digest('hex').slice(0, 10);
        const why = r.applied.map((a) => `**${a.old}** → **${a.new}**: ${a.reason || 'possible typo'}`).join('\n');
        comments.push({
            path: filePath, line: target + 1, side: 'RIGHT', hash,
            body: `Possible typo (${group[0].s.label}). Not changed automatically:\n\n${why}\n\n\`\`\`suggestion\n${indent}${JSON.stringify(r.text)}${comma}\n\`\`\`\n<!-- typo:${hash} -->`,
        });
    }
    return comments;
}

// ── the whole review ───────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array} head   data.json on the branch
 * @param {Array|null} base  data.json on the main branch (null with options.all)
 * @param {{ ai?: Object, allowlist?: string[], all?: boolean }} options
 */
async function reviewTypos(head, base, options = {}) {
    const allowlist = options.allowlist || [];
    const entries = changedBlocks(base, head, { all: options.all });
    const lines = collectLines(entries);
    const proseLines = lines.filter((l) => l.kind === 'prose');
    const mechanical = proseLines.flatMap(mechanicalIssues);
    const ai = await aiIssues(options.ai, lines, allowlist);
    const mixed = await mixedScriptIssues(options.ai, lines, allowlist, options.mixedAutoMin, options.equivalents);
    const decided = decide(lines, [...mechanical, ...ai.issues, ...mixed.issues], allowlist);
    const result = applyFixes(head, decided);
    const comments = buildSuggestionComments(result.data, result.suggestions);
    const verses = entries.filter((e) => VERSE.has(e.block.type)).map((e) => ({ label: e.label, id: e.block.id, flagged: decided.flags.filter((f) => f.blockId === e.block.id) }));
    const summary = { blocks: entries.length, lines: lines.length, fixes: result.applied.length, suggestions: comments.length, verses: verses.length };
    return { data: result.data, changed: result.applied.length > 0, applied: result.applied, comments, verses, dropped: decided.dropped, note: [ai.note, mixed.note].filter(Boolean).join('; '), mixedFound: mixed.found, summary, notApplied: result.notApplied };
}

function renderReport(r, { all = false } = {}) {
    const out = ['## Typo review', ''];
    const s = r.summary;
    out.push(`Looked at ${s.lines} line(s) in ${s.blocks} ${all ? 'block(s) of the whole book' : 'new or changed block(s)'}. Shloka and mantra blocks are never changed.${r.note ? ` ⚠️ ${r.note}.` : ''}`);
    out.push('');
    if (r.applied.length) {
        out.push(`### Fixed in this commit (${r.applied.length}): revert the commit to undo all of them`);
        out.push('| Block | Old | New | Reason |', '| --- | --- | --- | --- |');
        for (const a of r.applied) out.push(`| ${a.label} (${a.lang}) | ${esc(a.old)} | ${esc(a.new)} | ${esc(a.reason)} |`);
    } else out.push('### Fixed in this commit\nNothing needed fixing automatically.');
    out.push('');
    if (r.comments.length) {
        out.push(`### Doubtful (${r.comments.length}): one-click suggestions on the changed lines`);
        out.push('Open the **Files changed** tab and press *Commit suggestion* on the ones you agree with:');
        for (const c of r.comments) out.push(`- line ${c.line}: ${c.body.split('\n')[2].replace(/\*\*/g, '`')}`);
    } else out.push('### Doubtful\nNone.');
    out.push('');
    if (r.verses.length) {
        out.push('### Shlokas and mantras: check against the source');
        for (const v of r.verses) out.push(`- ${v.label}${v.flagged.length ? ` (the AI doubts: ${v.flagged.map((f) => `${f.old} → ${f.new}`).join('; ')})` : ''}`);
        out.push('');
    }
    if (r.mixedFound) out.push(`${r.mixedFound} English line(s) contain Kannada-script words (your own wording). Those the model was sure of, and whose round trip matched, were written in Latin letters above; the others are suggestions.\n`);
    if (r.notApplied.length) out.push(`${r.notApplied.length} fix(es) overlapped another on the same line and were skipped.\n`);
    return out.join('\n') + '\n';
}
const esc = (t) => String(t).replace(/\|/g, '\\|').replace(/\n/g, ' ');

module.exports = {
    loadAllowlist, loadEquivalents, skeleton, editDistance, changedBlocks, collectLines, mechanicalIssues, decide, applyToLine, applyFixes,
    buildSuggestionComments, reviewTypos, renderReport,
};

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { base: null, all: false, dryRun: false, report: null, suggestions: null, allowlist: ALLOWLIST_PATH, data: DATA_PATH, noAi: false, mixedAutoMin: MIXED_AUTO_MIN, equivalents: EQUIVALENTS_PATH };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--all') args.all = true;
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--no-ai') args.noAi = true;
        else if (a === '--base') args.base = path.resolve(argv[++i]);
        else if (a === '--report') args.report = argv[++i];
        else if (a === '--suggestions') args.suggestions = argv[++i];
        else if (a === '--allowlist') args.allowlist = path.resolve(argv[++i]);
        else if (a === '--data') args.data = path.resolve(argv[++i]);
        else if (a === '--equivalents') args.equivalents = path.resolve(argv[++i]);
        else if (a === '--mixed-auto-min') args.mixedAutoMin = Number(argv[++i]);
        else throw new Error(`Unknown option: ${a}`);
    }
    if (!args.base && !args.all) throw new Error('give --base <main branch data.json>, or --all to review the whole book');
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const raw = fs.readFileSync(args.data, 'utf8');
    const head = JSON.parse(raw);
    const base = args.base && fs.existsSync(args.base) ? JSON.parse(fs.readFileSync(args.base, 'utf8')) : null;
    const allowlist = fs.existsSync(args.allowlist) ? loadAllowlist(fs.readFileSync(args.allowlist, 'utf8')) : [];
    const r = await reviewTypos(head, base, { ai: args.noAi ? null : createGemini(), allowlist, all: args.all || !base, mixedAutoMin: args.mixedAutoMin, equivalents: fs.existsSync(args.equivalents) ? loadEquivalents(fs.readFileSync(args.equivalents, 'utf8')) : null });
    const markdown = renderReport(r, { all: args.all || !base });
    console.log(markdown);
    if (args.report) fs.writeFileSync(args.report, markdown);
    if (args.suggestions) fs.writeFileSync(args.suggestions, JSON.stringify(r.comments, null, 2));
    if (!args.dryRun && r.changed) fs.writeFileSync(args.data, JSON.stringify(r.data, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${r.changed && !args.dryRun}\nfixes=${r.applied.length}\nsuggestions=${r.comments.length}\n`);
}

if (require.main === module) {
    main().catch((e) => { console.error(`typo-review: ${e.message}`); process.exit(1); });
}
