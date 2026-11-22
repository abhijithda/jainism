#!/usr/bin/env node
// notes-to-blocks.js — turn a text file of rough notes (or a Q&A) into items and blocks in assets/data.json.
//
// You put a .txt file in content-inbox/ on a staging/... branch (see content-inbox/README.md) and push. The
// content-agent workflow runs this script first, then the existing pipeline (ids, timestamps, links, cross-references).
//
//   WHAT THE AI DECIDES        where the text splits into items and blocks, and the type of each block
//                              (paragraph / shloka / mantra / note). It answers with line NUMBERS only.
//   WHAT THE CODE DOES         copies your lines into the blocks. The AI never writes or retypes your text, and
//                              before anything is written verifyPreservation() proves that the lines going out are
//                              the lines that came in (only the "ಪ್ರಶ್ನೆ ಕರ್ತ:" / "ಉತ್ತರ:" style prefixes, surrounding
//                              spaces, blank lines and YouTube links are removed). If the proof fails, nothing is written.
//   LINKS                      YouTube links become `videos` entries ({ url, youtubeId }, ?t= kept) and leave the text.
//                              Other links stay in the text.
//   THE OTHER LANGUAGE         machine-translated, line for line, listed in the PR as "review this". A language you
//                              wrote is never overwritten. Shloka/mantra blocks are transliterated, not translated.
//   TAGS                       suggested in the PR only, never written.
//
// Without GEMINI_API_KEY the structure still works (blank lines, numbered points and Q/A prefixes decide the blocks);
// only the smarter split, the translations and the tag suggestions are skipped.
//
//   node scripts/notes-to-blocks.js                     every .txt in content-inbox/ (moved to content-inbox/done/)
//   node scripts/notes-to-blocks.js notes.txt --after A-11 --lang kn --dry-run
//   options: --after <place>  --lang kn|en  --followup  --keep  --report out.md  --data file.json  --no-ai
const fs = require('fs');
const path = require('path');
const { createGemini } = require('./lib/gemini');
const { findLinks, parseYouTube } = require('./lib/youtube');
const { insertIndex, maxNum, snippet } = require('./lib/book');
const { TRANSLIT_STYLE } = require('./lib/translit');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'assets', 'data.json');
const INBOX = path.join(ROOT, 'content-inbox');

const BLOCK_TYPES = ['paragraph', 'shloka', 'mantra', 'note'];
const ITEM_TYPES = ['question', 'answer'];
const QUESTION_PREFIX = /^(?:ಪ್ರಶ್ನೆ\s*ಕರ್ತ|ಪ್ರಶ್ನೆ|Inquirer|Question|Q)\s*[:：]\s*/iu;
const ANSWER_PREFIX = /^(?:ಉತ್ತರ|Answer|Ans|A)\s*[:：]\s*/iu;
const NUMBERED_POINT = /^\s*(?:\d+|[೦-೯]+)\s*[.)]\s/u;
const KANNADA = /[\u0C80-\u0CFF]/gu;
const LATIN = /[A-Za-z]/g;

// ── 1. reading the file ──────────────────────────────────────────────────────────────────────────────────────

/** Optional header (--- / key: value / ---) then the notes. Keys: after, lang, followup. */
function parseInbox(text) {
    let body = String(text).replace(/^\uFEFF/, '');
    const options = {};
    const m = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (m) {
        for (const line of m[1].split(/\r?\n/)) {
            const kv = line.match(/^\s*(\w+)\s*:\s*(.*?)\s*$/);
            if (kv) options[kv[1].toLowerCase()] = kv[2];
        }
        body = body.slice(m[0].length);
    }
    if (options.followup !== undefined) options.followup = /^(1|true|yes|y)$/i.test(options.followup);
    return { options, rawLines: body.split(/\r?\n/) };
}

/** The line as it will be stored: surrounding whitespace gone, YouTube links cut out (with one joining space). */
function stripVideoLinks(line) {
    let text = line;
    const links = findLinks(line).filter((l) => parseYouTube(l.url));
    for (const l of [...links].reverse()) {
        let { start, end } = l;
        if (text[start - 1] === '(' && text[end] === ')') { start -= 1; end += 1; }   // "(link)" leaves no empty brackets
        const before = text.slice(0, start).trimEnd();
        const after = text.slice(end).trimStart();
        // one space where the link was, none before punctuation that belongs to the sentence
        text = before && after ? `${before}${/^[.,;:!?)\]]/.test(after) ? '' : ' '}${after}` : before + after;
    }
    return { text: text.trim(), videos: links.map((l) => l.url) };
}

/**
 * Cleans the raw lines: no blank lines (remembered as `blankBefore`), no Q/A prefixes (remembered as `marker`),
 * YouTube links cut out and remembered with the content line they follow (`anchor`).
 * @returns {{ lines: {text:string, blankBefore:boolean, marker:string|null}[],
 *             videos: {url:string, anchor:number}[], otherLinks: string[], prefixesDropped: number }}
 */
function prepare(rawLines) {
    const lines = [];
    const videos = [];
    const otherLinks = [];
    let prefixesDropped = 0;
    let blank = false;
    let pendingMarker = null;
    let leading = []; // links seen before any text: they belong to the first line
    for (const raw of rawLines) {
        let line = raw.trim();
        if (!line) { blank = true; continue; }
        let marker = null;
        const q = line.match(QUESTION_PREFIX);
        const a = !q && line.match(ANSWER_PREFIX);
        if (q || a) { marker = q ? 'question' : 'answer'; line = line.slice((q || a)[0].length).trim(); prefixesDropped++; }
        const stripped = stripVideoLinks(line);
        for (const l of findLinks(stripped.text)) otherLinks.push(l.url);
        if (marker) pendingMarker = marker;
        if (!stripped.text) {
            // a line that was only a link (or only a prefix)
            for (const url of stripped.videos) (lines.length ? videos.push({ url, anchor: lines.length - 1 }) : leading.push(url));
            continue;
        }
        lines.push({ text: stripped.text, blankBefore: blank, marker: pendingMarker });
        pendingMarker = null;
        blank = false;
        const index = lines.length - 1;
        for (const url of leading.splice(0)) videos.push({ url, anchor: index });
        for (const url of stripped.videos) videos.push({ url, anchor: index });
    }
    for (const url of leading) videos.push({ url, anchor: 0 }); // links but no text at all
    return { lines, videos, otherLinks, prefixesDropped };
}

/** 'kn' or 'en' for a set of lines: the script that has more letters (Latin text, including romanised Hindi, is 'en'). */
function detectLang(texts) {
    const all = texts.join(' ');
    const kn = (all.match(KANNADA) || []).length;
    const latin = (all.match(LATIN) || []).length;
    return kn > latin ? 'kn' : 'en';
}

// ── 2. the plan: which lines make which items and blocks ──────────────────────────────────────────────────────

/** Items forced by "Q:"/"A:" style prefixes: [{ type, start }]. With no prefix: one answer starting at line 0. */
function skeletonOf(lines) {
    const marked = lines.map((l, i) => (l.marker ? { type: l.marker, start: i } : null)).filter(Boolean);
    if (!marked.length) return { forced: false, items: [{ type: 'answer', start: 0 }] };
    if (marked[0].start > 0) marked.unshift({ type: 'answer', start: 0 });
    return { forced: true, items: marked };
}

const looksLikeShloka = (texts) => texts.some((t) => /॥|।\s*$/.test(t)) && texts.some((t) => /[\u0900-\u097F]/.test(t));
const looksLikeMantra = (texts) => texts.length === 1 && /^\s*(ॐ|ಓಂ|ओं)/.test(texts[0]);

/** The plan with no AI: items from the prefixes, blocks from blank lines and numbered points. */
function fallbackPlan(lines) {
    const sk = skeletonOf(lines);
    const items = sk.items.map((it, k) => {
        const end = (sk.items[k + 1] ? sk.items[k + 1].start : lines.length) - 1;
        const blocks = [];
        for (let i = it.start; i <= end; i++) {
            const startsNew = i === it.start || lines[i].blankBefore || NUMBERED_POINT.test(lines[i].text);
            if (startsNew) blocks.push({ type: 'paragraph', from: i, to: i, tags: [] });
            else blocks[blocks.length - 1].to = i;
        }
        for (const b of blocks) {
            const texts = lines.slice(b.from, b.to + 1).map((l) => l.text);
            if (looksLikeMantra(texts)) b.type = 'mantra';
            else if (looksLikeShloka(texts)) b.type = 'shloka';
        }
        return { type: it.type, blocks };
    });
    return { items };
}

/** Throws a readable error unless the plan covers lines 0..n-1 once, in order, and follows the Q/A prefixes. */
function validatePlan(plan, lines) {
    if (!plan || !Array.isArray(plan.items) || !plan.items.length) throw new Error('the plan has no items');
    let next = 0;
    const starts = [];
    for (const [k, item] of plan.items.entries()) {
        if (!ITEM_TYPES.includes(item.type)) throw new Error(`item ${k}: type must be question or answer`);
        if (!Array.isArray(item.blocks) || !item.blocks.length) throw new Error(`item ${k}: no blocks`);
        starts.push({ type: item.type, start: item.blocks[0].from });
        for (const [j, b] of item.blocks.entries()) {
            if (!BLOCK_TYPES.includes(b.type)) throw new Error(`item ${k} block ${j}: unknown type "${b.type}"`);
            if (!Number.isInteger(b.from) || !Number.isInteger(b.to) || b.to < b.from) throw new Error(`item ${k} block ${j}: bad line range`);
            if (b.from !== next) throw new Error(`item ${k} block ${j}: starts at line ${b.from} but line ${next} is next (lines must be covered once, in order)`);
            next = b.to + 1;
        }
    }
    if (next !== lines.length) throw new Error(`the plan covers ${next} of ${lines.length} lines`);
    const sk = skeletonOf(lines);
    if (sk.forced) {
        const same = sk.items.length === starts.length && sk.items.every((s, i) => s.type === starts[i].type && s.start === starts[i].start);
        if (!same) throw new Error('the items do not follow the Q:/A: prefixes in the text');
    }
    return plan;
}

const PLAN_SYSTEM = `You split rough notes into items and blocks for a Jainism Q&A book. You never write, correct, shorten or reorder the text: you only say where it splits, using line numbers.
Return JSON only: {"items":[{"type":"question"|"answer","blocks":[{"type":"paragraph"|"shloka"|"mantra"|"note","from":N,"to":N,"tags":"a few simple words separated by spaces"}]}]}
Rules:
- Every line number from 0 to the last must be in exactly one block, in order, with no gaps: the first block of the first item starts at 0, each next block starts right after the previous one ends.
- "¶" in front of a line means the writer left a blank line before it.
- Default is ONE item of type "answer". Start a new item only when the topic clearly changes (for example a story after a list of notes), or when a line is clearly a question asked by an inquirer ("question" items hold the question only).
- If the text has question/answer prefixes the items are already decided: the prompt lists them, follow exactly those items.
- A heading that introduces a list or a section is its own block. Each numbered point (1. 2. 3.) is one block together with the unnumbered lines that follow it until the next number. Sentences of a story, one per line, stay together in one block.
- "shloka" = a Sanskrit/Prakrit verse (usually in Devanagari or Kannada script with danda marks, or a quoted verse with its source); "mantra" = a short chant to recite; "note" = a remark to the reader or a source/verification reminder; everything else "paragraph". When in doubt use "paragraph".
- tags: simple lowercase English words, spelled simply (abhisheka, panchamruta, indra), at most 6 per block.`;

/** Ask the model for the plan; one retry that shows it the validation error; else the rule-based plan. */
async function makePlan(ai, lines) {
    const fallback = () => fallbackPlan(lines);
    if (!ai || !ai.available) return { plan: fallback(), source: 'rules', note: 'no GEMINI_API_KEY: the split uses blank lines, numbered points and Q/A prefixes only' };
    const sk = skeletonOf(lines);
    const listing = lines.map((l, i) => `[${i}] ${l.blankBefore ? '¶ ' : ''}${l.text}`).join('\n');
    const decided = sk.forced
        ? `Items already decided by prefixes: ${sk.items.map((s) => `${s.type} starting at line ${s.start}`).join('; ')}.\n\n` : '';
    let prompt = `${decided}Lines:\n${listing}`;
    let error = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const plan = await ai.json({ system: PLAN_SYSTEM, prompt: error ? `${prompt}\n\nYour previous answer was rejected: ${error}\nAnswer again.` : prompt });
            return { plan: validatePlan(plan, lines), source: 'ai' };
        } catch (e) { error = e.message; if (/GEMINI_API_KEY|answered 4\d\d/.test(error)) break; }
    }
    return { plan: fallback(), source: 'rules', note: `the AI split was not usable (${error}); the rule-based split was used` };
}

// ── 3. building the items ────────────────────────────────────────────────────────────────────────────────────

const cleanTags = (tags) => (Array.isArray(tags) ? tags.join(' ') : String(tags || '')).split(/\s+/).filter(Boolean).slice(0, 6);
const watchKey = (v) => `${v.youtubeId}|${v.url}`;

/**
 * Items with no ids and no nums yet, plus a parallel `meta` (language of each block, suggested tags, videos).
 * Blocks hold ONLY your lines in their own language; the other language is an empty list until translated.
 */
function buildItems(prepared, plan, options = {}) {
    const { lines, videos } = prepared;
    const items = [];
    const meta = [];
    for (const planned of plan.items) {
        const blocks = [];
        const blockMeta = [];
        planned.blocks.forEach((b, j) => {
            const texts = lines.slice(b.from, b.to + 1).map((l) => l.text);
            const lang = options.lang || detectLang(texts);
            const seen = new Set();
            const vids = [];
            for (const v of videos) {
                if (v.anchor < b.from || v.anchor > b.to) continue;
                const yt = parseYouTube(v.url);
                const entry = { url: v.url, youtubeId: yt.id };
                if (!seen.has(watchKey(entry))) { seen.add(watchKey(entry)); vids.push(entry); }
            }
            blocks.push({
                num: j + 1, type: b.type,
                content: lang === 'kn' ? { kn: texts, en: [] } : { kn: [], en: texts },
                tags: [], videos: vids, images: [],
            });
            blockMeta.push({ lang, other: lang === 'kn' ? 'en' : 'kn', suggestedTags: cleanTags(b.tags), from: b.from, to: b.to, translated: false, translationNote: '' });
        });
        items.push({ type: planned.type, blocks });
        meta.push({ blocks: blockMeta });
    }
    return { items, meta };
}

/** Throws unless the lines in your original text (minus prefixes, links, blanks) are exactly the lines in the blocks. */
function verifyPreservation(originalText, items, meta) {
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    const { rawLines } = parseInbox(originalText);
    const expected = [];
    for (const raw of rawLines) {
        let line = raw.trim();
        if (!line) continue;
        line = line.replace(QUESTION_PREFIX, '').replace(ANSWER_PREFIX, '');
        line = norm(stripVideoLinks(line).text);
        if (line) expected.push(line);
    }
    const actual = [];
    items.forEach((item, i) => item.blocks.forEach((b, j) => actual.push(...b.content[meta[i].blocks[j].lang].map(norm))));
    if (expected.length !== actual.length) throw new Error(`lines in (${expected.length}) and lines out (${actual.length}) differ`);
    expected.forEach((line, i) => {
        if (line !== actual[i]) throw new Error(`line ${i + 1} changed: "${line}" became "${actual[i]}"`);
    });
    return true;
}

// ── 4. the other language ────────────────────────────────────────────────────────────────────────────────────

const LANG_NAME = { kn: 'Kannada', en: 'English' };

/**
 * The label a block will show in the app (src/core/blocks.js): shloka S, note N, mantra M, images I; a plain paragraph takes
 * its item's letter (Q / A). So the PR says N-29.8 for a note, the same as the book and the typo review do.
 */
const BLOCK_LETTERS = { shloka: 'S', note: 'N', images: 'I', mantra: 'M' };
function reportLabel(item, block, shownNum) {
    return `${BLOCK_LETTERS[block.type] || item.type[0].toUpperCase()}-${shownNum ?? '?'}.${block.num}`;
}
const TRANSLATE_SYSTEM = `You translate lines from a Jainism Q&A book. Return JSON only: {"blocks":[{"key":"...","lines":["..."]}]}.
Rules: one output line for every input line, same order, so the count must match exactly; keep numbering such as "1." and proper names; keep Sanskrit and Prakrit technical terms (abhisheka, kalasha, dravya ...) in the target script rather than explaining them; never add comments, notes or links.
Blocks with "mode":"transliterate" are verses or mantras: do NOT translate the meaning, write the same words in the other script (Kannada script <-> Latin letters), as faithfully as possible.
${TRANSLIT_STYLE}`;

/** Fill the empty language of every block with a machine translation. Records on `meta` what happened. */
async function translateBlocks(ai, items, meta) {
    const jobs = [];
    items.forEach((item, i) => item.blocks.forEach((b, j) => {
        const m = meta[i].blocks[j];
        jobs.push({ key: `${i}.${j}`, block: b, m, from: m.lang, to: m.other,
            mode: b.type === 'shloka' || b.type === 'mantra' ? 'transliterate' : 'translate', lines: b.content[m.lang] });
    }));
    if (!ai || !ai.available) { jobs.forEach((j) => { j.m.translationNote = 'not translated (no GEMINI_API_KEY)'; }); return; }
    for (const dir of [['kn', 'en'], ['en', 'kn']]) {
        let todo = jobs.filter((j) => j.from === dir[0]);
        for (let attempt = 0; attempt < 2 && todo.length; attempt++) {
            const chunks = [];
            let cur = [], count = 0;
            for (const j of todo) { if (count + j.lines.length > 80 && cur.length) { chunks.push(cur); cur = []; count = 0; } cur.push(j); count += j.lines.length; }
            if (cur.length) chunks.push(cur);
            for (const chunk of chunks) {
                try {
                    const answer = await ai.json({
                        system: TRANSLATE_SYSTEM,
                        prompt: `Translate from ${LANG_NAME[dir[0]]} to ${LANG_NAME[dir[1]]}.\n${JSON.stringify({ blocks: chunk.map((j) => ({ key: j.key, mode: j.mode, lines: j.lines })) })}`,
                    });
                    for (const out of answer.blocks || []) {
                        const job = chunk.find((j) => j.key === out.key);
                        if (!job || !Array.isArray(out.lines) || out.lines.length !== job.lines.length || out.lines.some((l) => typeof l !== 'string')) continue;
                        job.block.content[job.to] = out.lines.map((l) => l.trim());
                        job.m.translated = true;
                    }
                } catch (e) { chunk.forEach((j) => { j.m.translationNote = `translation failed: ${e.message}`; }); }
            }
            todo = todo.filter((j) => !j.m.translated);
        }
        todo.forEach((j) => { j.m.translationNote = j.m.translationNote || 'translation did not come back with the same number of lines'; });
    }
}

// ── 5. numbers, position, the whole conversion ────────────────────────────────────────────────────────────────

/**
 * Give nums and mark standalone answers, once the place in the book is known.
 *  - a question takes the next free num; an answer right below a question takes none (the pipeline links it and it
 *    shares the question's number);
 *  - any other answer is a note-style answer with a num of its own; `_agent.standalone` tells the pipeline not to
 *    treat it as a follow-up of the answer above (unless you wrote `followup: yes`). The pipeline removes the marker.
 */
function numberAndMark(data, at, items, options = {}) {
    let next = maxNum(data) + 1;
    const placed = items.map((item) => ({ ...item }));
    placed.forEach((item, k) => {
        const previous = k === 0 ? data[at - 1] : placed[k - 1];
        if (item.type === 'question') { item.num = next++; return; }
        if (previous && previous.type === 'question') return;
        item.num = next++;
        const followsAnswer = previous && previous.type === 'answer';
        if (!(options.followup && followsAnswer)) item._agent = { standalone: true };
    });
    return placed.map((item) => {
        const { num, type, blocks, _agent } = item;
        return { ...(num !== undefined ? { num } : {}), type, ...(_agent ? { _agent } : {}), blocks };
    });
}

/**
 * Convert one file of notes. Returns the new data (items spliced in) and a Markdown report.
 * @param {string} text  the file
 * @param {Array} data   current data.json
 * @param {{ ai?: Object, name?: string, after?: string, lang?: string, followup?: boolean }} options  (the file's header is the fallback)
 */
async function convertNotes(text, data, options = {}) {
    const parsed = parseInbox(text);
    const opts = { ...parsed.options, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
    if (opts.lang && !['kn', 'en'].includes(opts.lang)) throw new Error(`lang must be kn or en, not "${opts.lang}"`);
    const prepared = prepare(parsed.rawLines);
    if (!prepared.lines.length) throw new Error('the file has no text');
    const { plan, source, note } = await makePlan(options.ai, prepared.lines);
    const built = buildItems(prepared, plan, { lang: opts.lang });
    verifyPreservation(text, built.items, built.meta);               // before translating, and again after
    await translateBlocks(options.ai, built.items, built.meta);
    verifyPreservation(text, built.items, built.meta);               // translating must not have touched your lines
    const at = insertIndex(data, opts.after);
    const placed = numberAndMark(data, at, built.items, opts);
    const next = [...data.slice(0, at), ...placed, ...data.slice(at)];
    const report = renderReport({ name: options.name || 'notes', prepared, built, placed, planSource: source, planNote: note, at, data, after: opts.after, ai: options.ai });
    return { data: next, report, count: placed.length, at };
}

// ── 6. the report ────────────────────────────────────────────────────────────────────────────────────────────

const clip = (s, n = 90) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function renderReport({ name, prepared, built, placed, planSource, planNote, at, data, after, ai }) {
    const out = [];
    const where = at >= data.length ? 'at the end of data.json' : `after item \`${data[at - 1].id}\`${after ? ` (${after})` : ''}`;
    out.push(`### Notes to blocks: \`${name}\``);
    out.push(`- ${placed.length} item(s) inserted ${where}; split by ${planSource === 'ai' ? 'the AI (line numbers only)' : 'rules'}. ${planNote ? `⚠️ ${planNote}.` : ''}`);
    out.push(`- ✅ verified: the lines in your text are exactly the lines in the blocks (removed: ${prepared.prefixesDropped} Q/A prefix(es), ${prepared.videos.length} video link(s), blank lines, surrounding spaces).`);
    if (prepared.otherLinks.length) out.push(`- links left in the text (not YouTube): ${prepared.otherLinks.map((u) => `<${u}>`).join(', ')}`);
    const numbers = placed.filter((i) => i.num !== undefined).map((i) => `${i.type} → \`num: ${i.num}\``);
    out.push(`- numbers given (the next free ones; renumber as you like): ${numbers.join(', ') || 'none (answers share their question\'s number)'}`);
    out.push('');
    const review = [], missing = [], tags = [], verses = [];
    let lastQuestionNum;
    placed.forEach((item, i) => {
        if (item.type === 'question') lastQuestionNum = item.num;
        // the label the block will show once merged (an answer under a question shares its number)
        const shownNum = item.num !== undefined ? item.num : lastQuestionNum;
        out.push(`**${item.type[0].toUpperCase() + item.type.slice(1)} ${i + 1}**${item.num !== undefined ? ` (num ${item.num})` : ''}`);
        item.blocks.forEach((b, j) => {
            const m = built.meta[i].blocks[j];
            const label = reportLabel(item, b, shownNum);
            const vids = b.videos.map((v) => `${v.youtubeId}${/[?&]t=/.test(v.url) ? ` (${v.url.match(/[?&]t=([^&]+)/)[1]})` : ''}`);
            out.push(`- ${label} · ${b.type} · you wrote it in ${LANG_NAME[m.lang]} (${b.content[m.lang].length} line(s))${vids.length ? ` · video: ${vids.join(', ')}` : ''}: ${clip(b.content[m.lang][0])}`);
            if (m.translated) review.push({ label, m, b });
            else missing.push({ label, note: m.translationNote || 'not translated' });
            if (b.type === 'shloka' || b.type === 'mantra') verses.push(label);
            if (m.suggestedTags.length) tags.push(`${label}: \`${m.suggestedTags.join(' ')}\``);
        });
        out.push('');
    });
    if (review.length) {
        const targets = [...new Set(review.map((r) => LANG_NAME[r.m.other]))].join(' and ');
        out.push(`#### Machine-translated: review this (${targets}; never overwrites a language you wrote)`);
        for (const { label, m, b } of review) {
            const tag = b.type === 'shloka' || b.type === 'mantra' ? ' (transliteration, check against the source)' : '';
            out.push(`- ${label} → ${LANG_NAME[m.other]}${tag}: ${clip(b.content[m.other].join(' / '), 160)}`);
        }
        out.push('');
    }
    if (missing.length) {
        out.push('#### Missing translations');
        for (const x of missing) out.push(`- ${x.label}: ${x.note}`);
        out.push('');
    }
    if (verses.length) out.push(`#### Verses and mantras\nChecked by nobody yet: compare ${verses.join(', ')} with the source.\n`);
    if (tags.length) { out.push('#### Suggested tags (not written to data.json)'); tags.forEach((t) => out.push(`- ${t}`)); out.push(''); }
    return out.join('\n');
}

module.exports = {
    parseInbox, prepare, stripVideoLinks, detectLang, skeletonOf, fallbackPlan, validatePlan, makePlan, buildItems,
    verifyPreservation, translateBlocks, numberAndMark, convertNotes, renderReport, snippet, reportLabel,
};

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { files: [], dryRun: false, keep: false, report: null, data: DATA_PATH, after: undefined, lang: undefined, followup: undefined, noAi: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--keep') args.keep = true;
        else if (a === '--no-ai') args.noAi = true;
        else if (a === '--followup') args.followup = true;
        else if (a === '--report') args.report = argv[++i];
        else if (a === '--after') args.after = argv[++i];
        else if (a === '--lang') args.lang = argv[++i];
        else if (a === '--data') args.data = path.resolve(argv[++i]);
        else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
        else args.files.push(path.resolve(a));
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let files = args.files;
    if (!files.length && fs.existsSync(INBOX)) {
        files = fs.readdirSync(INBOX).filter((f) => /\.txt$/i.test(f)).sort().map((f) => path.join(INBOX, f));
    }
    if (!files.length) { console.log('No notes to process (content-inbox/ has no .txt file).'); if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'notes=false\n'); return; }
    const raw = fs.readFileSync(args.data, 'utf8');
    let data = JSON.parse(raw);
    const ai = args.noAi ? null : createGemini();
    const reports = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const result = await convertNotes(text, data, { ai, name: path.basename(file), after: args.after, lang: args.lang, followup: args.followup });
        data = result.data;
        reports.push(result.report);
        console.log(result.report);
        if (!args.dryRun && !args.keep && path.dirname(file) === INBOX) {
            fs.mkdirSync(path.join(INBOX, 'done'), { recursive: true });
            fs.renameSync(file, path.join(INBOX, 'done', path.basename(file)));
        }
    }
    if (ai && ai.printUsage) ai.printUsage();
    const markdown = `## Content pipeline agent: notes to blocks\n\n${reports.join('\n\n')}\n`;
    if (args.report) fs.writeFileSync(args.report, markdown);
    if (args.dryRun) { console.log('(dry run: nothing written)'); return; }
    fs.writeFileSync(args.data, JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'notes=true\n');
}

if (require.main === module) {
    main().catch((e) => { console.error(`notes-to-blocks: ${e.message}`); process.exit(1); });
}
