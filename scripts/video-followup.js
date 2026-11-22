#!/usr/bin/env node
// video-followup.js — "follow up of A-11.2": a YouTube clip -> a new follow-up answer that references A-11.2.
//
//   node scripts/video-followup.js --target A-11.2 --url https://youtu.be/XXXXXXXXXXX --start 12m30s --duration 6m \
//        --speaker "Acharya Vidyasagar Swami" [--dry-run] [--report out.md] [--transcript-out t.txt]
//
// What happens (needs GEMINI_API_KEY; the Gemini API reads the public YouTube link itself, so GitHub never downloads it):
//   1. the target block (A-11.2) is found; its item and the question it answers are the CONTEXT;
//   2. call 1 (sees the video clip): a timestamped transcript of just that clip;
//   3. call 2 (text only): from the transcript and the context, the points that ADD to A-11.2 (not what it already says),
//      each pointing at the transcript lines it comes from, plus any Sanskrit/Prakrit recitation (as transcribed);
//   4. the code builds ONE new follow-up answer, placed right below the answer it extends:
//        references: [the A-11.2 block]; num: the next free one; a paragraph block with the points (English + Kannada,
//        machine-written, to review) and the video attached at the clip start (?t=); and, only if there was a recitation,
//        a `note` block "machine-transcribed, verify against the source". Sanskrit/Prakrit is NEVER put in a shloka block.
//   5. the report (the PR description) shows, next to each point, the transcript excerpt it came from with a
//      timestamp link, so every point can be checked against the video in one click.
//
// Dry run first: --dry-run prints the transcript and the points and writes nothing. Use it on a video you know well,
// because how good Kannada transcripts are is unknown until you see one.
const fs = require('fs');
const path = require('path');
const { createGemini } = require('./lib/gemini');
const { parseYouTube, parseOffset, momentUrl } = require('./lib/youtube');
const { findBlock, maxNum, snippet, byId, blockLabel } = require('./lib/book');
const { TRANSLIT_STYLE } = require('./lib/translit');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'assets', 'data.json');

const KN_NOTE = 'ವೀಡಿಯೊದಿಂದ ಯಂತ್ರದ ಮೂಲಕ ಲಿಪ್ಯಂತರ ಮಾಡಿದ್ದು, ಪರಿಶೀಲಿಸಲಾಗಿಲ್ಲ: ಮೂಲ ಗ್ರಂಥದೊಂದಿಗೆ ಹೋಲಿಸಿ ಪರಿಶೀಲಿಸಿ.';
const EN_NOTE = 'Machine-transcribed from the video, not checked: verify against the source.';

// ── time ─────────────────────────────────────────────────────────────────────────────────────────────────────
const mmss = (sec) => {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
};

/** The clip: start (seconds, from --start, else the link's ?t=, else 0) and end (start + duration, or null = to the end). */
function clipWindow({ url, start, duration }) {
    const yt = parseYouTube(url);
    if (!yt) throw new Error(`"${url}" is not a YouTube link`);
    const s = start === undefined || start === '' ? (yt.start ?? 0) : parseOffset(start);
    if (s === null) throw new Error(`cannot read the start time "${start}" (write 90, 1:30, 12m30s or 1h2m3s)`);
    let end = null;
    if (duration !== undefined && duration !== '') {
        const d = parseOffset(duration);
        if (d === null || d <= 0) throw new Error(`cannot read the duration "${duration}" (write 5m, 90s or 5:00)`);
        if (d < 10) throw new Error(`a duration of ${d} seconds looks like a mistake: write 5m for five minutes, or 300s`);
        end = s + d;
    }
    return { id: yt.id, start: s, end };
}

// ── call 1: the transcript ───────────────────────────────────────────────────────────────────────────────────

const TRANSCRIBE_SYSTEM = `You transcribe speech from a video of a Jain teacher (pravachan, Q&A, lecture). Write down what is said, as spoken, in the language spoken (Kannada in Kannada script, Hindi in Devanagari, English in Latin letters). Do not translate, summarise, correct or add anything. If a word is unclear write [unclear] instead of guessing.
Return JSON only: {"language":"kn|hi|en|mixed","transcript":[{"ts":"MM:SS","text":"..."}]}
One entry for each sentence or pause (about 5-20 seconds of speech). "ts" is where the entry starts, counted from the START OF THE WHOLE VIDEO (not from the start of the clip you were given), as MM:SS or H:MM:SS.`;

/** Parts for the call: the YouTube link (public videos only) and, when a window is given, the clip offsets. */
function videoParts({ id, start, end }) {
    const part = { fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` } };
    if (start > 0 || end !== null) {
        part.videoMetadata = { startOffset: `${Math.floor(start)}s`, ...(end !== null ? { endOffset: `${Math.floor(end)}s` } : {}) };
    }
    return [part];
}

const tsToSeconds = (ts) => {
    const m = String(ts).trim().match(/^(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/);
    return m ? (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
};

/**
 * Turn the model's entries into { sec, text } and decide whether its timestamps counted from the start of the video or from
 * the start of the clip (Gemini's documentation and users disagree; so both are handled and the report says which was seen).
 */
function normalizeTranscript(entries, window) {
    const rows = (Array.isArray(entries) ? entries : [])
        .map((e) => ({ sec: tsToSeconds(e && e.ts), text: String((e && e.text) || '').trim() }))
        .filter((e) => e.sec !== null && e.text);
    let mode = 'absolute';
    if (rows.length && window.start >= 30) {
        const max = Math.max(...rows.map((r) => r.sec));
        const length = window.end !== null ? window.end - window.start : null;
        const looksRelative = length !== null ? max <= length + 10 : max < window.start - 5;
        if (looksRelative) { rows.forEach((r) => { r.sec += window.start; }); mode = 'relative'; }
    }
    const outside = window.end !== null ? rows.filter((r) => r.sec < window.start - 5 || r.sec > window.end + 5).length : rows.filter((r) => r.sec < window.start - 5).length;
    return { rows: rows.sort((a, b) => a.sec - b.sec), mode, outside };
}

async function transcribe(ai, window) {
    const prompt = window.end !== null
        ? `Transcribe the speech between ${mmss(window.start)} and ${mmss(window.end)} of the video, and nothing outside it.`
        : `Transcribe the speech from ${mmss(window.start)} to the end of the video.`;
    const answer = await ai.json({ system: TRANSCRIBE_SYSTEM, prompt, parts: videoParts(window) });
    const { rows, mode, outside } = normalizeTranscript(answer.transcript, window);
    if (!rows.length) throw new Error('the model returned no transcript for this clip (is the video public, and does it have speech?)');
    return { rows, mode, outside, language: answer.language || '?' };
}

// ── context from the book ────────────────────────────────────────────────────────────────────────────────────

const lang = (block, l) => ((block.content || {})[l] || []).filter((x) => String(x).trim());

/** The target block, the answer it belongs to, and the question(s) that answer replies to (one hop through references). */
function contextFor(data, hit) {
    const itemById = byId(data);
    const blockOwner = {};
    for (const it of data) for (const b of it.blocks || []) blockOwner[b.id] = it;
    const questions = [];
    const visit = (item, depth) => {
        for (const ref of item.references || []) {
            const target = itemById[ref] || blockOwner[ref];
            if (!target) continue;
            if (target.type === 'question') questions.push(target);
            else if (depth < 1) visit(target, depth + 1);
        }
    };
    visit(hit.item, 0);
    const text = (b) => ({ label: blockLabel(blockOwner[b.id], b, itemById), en: lang(b, 'en'), kn: lang(b, 'kn') });
    return {
        target: text(hit.block),
        answer: (hit.item.blocks || []).filter((b) => b.id !== hit.block.id).map(text),
        questions: [...new Set(questions)].flatMap((q) => (q.blocks || []).map(text)),
    };
}

// ── call 2: the points ───────────────────────────────────────────────────────────────────────────────────────

const POINTS_SYSTEM = `You help add a follow-up to a Jainism Q&A book. You get the book's existing answer (the TARGET) with its question, and a transcript of a teacher speaking in a video.
Find what the speaker says that ADDS to the target: new details, a different example, a source named, a clarification. Skip what the target already says, greetings, jokes and unrelated topics. If the speaker adds nothing, return no points.
Return JSON only:
{"speakerKn":"the speaker's name in Kannada, or empty",
 "points":[{"en":"one short sentence in English","kn":"the same sentence in Kannada","lines":[transcript line numbers it comes from]}],
 "recitations":[transcript line numbers where the speaker recites a Sanskrit or Prakrit verse, mantra or quotation]}
Rules:
- Write each point in your own words, short and plain, in the style of the target; do not copy the speaker's sentences. Never invent a source, a name or a number that is not in the transcript.
- Every point must list the transcript line numbers that support it, exactly as given in [brackets].
- Never write out a Sanskrit or Prakrit verse yourself: only give the line numbers in "recitations".
- At most 8 points.
${TRANSLIT_STYLE}`;

const joined = (xs) => xs.join(' / ');

/** Ask for the points, then check every claim the model made about where it came from. */
async function extractPoints(ai, context, rows, speaker) {
    const listing = rows.map((r, i) => `[${i}] ${mmss(r.sec)} ${r.text}`).join('\n');
    const prompt = [
        `TARGET ${context.target.label}:\n${joined(context.target.en) || joined(context.target.kn)}\n${context.target.kn.length && context.target.en.length ? joined(context.target.kn) : ''}`,
        context.answer.length ? `REST OF THE SAME ANSWER:\n${context.answer.map((b) => `${b.label}: ${joined(b.en) || joined(b.kn)}`).join('\n')}` : '',
        context.questions.length ? `QUESTION:\n${context.questions.map((b) => joined(b.en) || joined(b.kn)).join('\n')}` : '',
        speaker ? `SPEAKER: ${speaker}` : '',
        `TRANSCRIPT:\n${listing}`,
    ].filter(Boolean).join('\n\n');
    const answer = await ai.json({ system: POINTS_SYSTEM, prompt });
    const valid = (n) => Number.isInteger(n) && n >= 0 && n < rows.length;
    const points = [], dropped = [];
    for (const p of Array.isArray(answer.points) ? answer.points : []) {
        const lines = [...new Set((Array.isArray(p && p.lines) ? p.lines : []).filter(valid))].sort((a, b) => a - b);
        const en = typeof (p && p.en) === 'string' ? p.en.trim() : '';
        const kn = typeof (p && p.kn) === 'string' ? p.kn.trim() : '';
        if (!lines.length || (!en && !kn)) { dropped.push({ en: en || kn, why: lines.length ? 'empty point' : 'no valid transcript line to back it' }); continue; }
        points.push({ en, kn, lines, from: rows[lines[0]].sec, excerpt: lines.map((i) => rows[i].text).join(' ') });
    }
    const recitations = [...new Set((Array.isArray(answer.recitations) ? answer.recitations : []).filter(valid))].sort((a, b) => a - b)
        .map((i) => ({ sec: rows[i].sec, text: rows[i].text }));
    return { points, recitations, dropped, speakerKn: typeof answer.speakerKn === 'string' ? answer.speakerKn.trim() : '' };
}

// ── the new item ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The follow-up item (no id yet: the pipeline gives it one), spliced in right below the target's item.
 * @returns {{ data: Array, item: Object, at: number }}
 */
function buildFollowUp(data, hit, window, extracted, speaker) {
    const needKn = extracted.points.every((p) => p.kn), needEn = extracted.points.every((p) => p.en);
    const head = (l) => (speaker ? [`${l === 'kn' ? (extracted.speakerKn || speaker) : speaker}:`] : []);
    const content = {
        kn: needKn ? [...head('kn'), ...extracted.points.map((p) => p.kn)] : [],
        en: needEn ? [...head('en'), ...extracted.points.map((p) => p.en)] : [],
    };
    const blocks = [{ num: 1, type: 'paragraph', content, tags: [], videos: [{ url: momentUrl(window.id, window.start), youtubeId: window.id }], images: [] }];
    if (extracted.recitations.length) {
        const quotes = extracted.recitations.map((r) => r.text);
        blocks.push({ num: 2, type: 'note', content: { kn: [KN_NOTE, ...quotes], en: [EN_NOTE, ...quotes] }, tags: [], videos: [], images: [] });
    }
    const item = { num: maxNum(data) + 1, type: 'answer', references: [hit.block.id], blocks };
    const at = data.indexOf(hit.item) + 1;
    return { data: [...data.slice(0, at), item, ...data.slice(at)], item, at };
}

// ── the report ───────────────────────────────────────────────────────────────────────────────────────────────

const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function renderReport({ hit, window, transcript, extracted, context, model, item, dryRun }) {
    const link = (sec) => `[${mmss(sec)}](${momentUrl(window.id, sec)})`;
    const o = [`## Video follow-up of ${hit.label}`, ''];
    o.push(`- target: **${hit.label}**: ${snippet(hit.block)}`);
    o.push(`- video: <https://youtu.be/${window.id}> · clip ${mmss(window.start)} to ${window.end !== null ? mmss(window.end) : 'the end'} · transcript language: ${transcript.language} · model: \`${model}\``);
    o.push(`- timestamps from the model counted from the ${transcript.mode === 'relative' ? '**start of the clip** (shifted by the clip start so the links below land in the right place)' : 'start of the video'}${transcript.outside ? ` · ⚠️ ${transcript.outside} transcript line(s) fall outside the clip: the model may have drifted` : ''}`);
    o.push('- ⚠️ **Everything below is a machine-made draft.** The Kannada and English points are written by the model from a machine transcript; check each against the video (links below).');
    o.push('');
    if (extracted.points.length) {
        o.push(`### Points added${dryRun ? ' (dry run: nothing written)' : ` to the new answer (num ${item.num}, references ${hit.label})`}`);
        extracted.points.forEach((p, i) => {
            o.push(`${i + 1}. **${p.en || p.kn}**${p.en && p.kn ? `  \n   ${p.kn}` : ''}`);
            o.push(`   > ${clip(p.excerpt, 400)} (${link(p.from)})`);
        });
    } else o.push('### Points added\nThe speaker adds nothing to this block in this clip, so no block was made.');
    o.push('');
    if (extracted.recitations.length) {
        o.push('### Sanskrit/Prakrit recitation: put in a `note` block, verify against the source');
        for (const r of extracted.recitations) o.push(`- ${link(r.sec)} ${r.text}`);
        o.push('');
    }
    if (extracted.dropped.length) o.push(`Dropped ${extracted.dropped.length} point(s) the model could not back with a transcript line: ${extracted.dropped.map((d) => `"${clip(d.en, 60)}" (${d.why})`).join('; ')}\n`);
    o.push(`<details><summary>Context given to the model</summary>\n\n${context.questions.length ? `Question: ${clip(joined(context.questions[0].en) || joined(context.questions[0].kn), 300)}\n\n` : ''}${hit.label}: ${clip(joined(context.target.en) || joined(context.target.kn), 600)}\n</details>\n`);
    const full = transcript.rows.map((r) => `${link(r.sec)} ${r.text}`).join('\n');
    o.push(`<details><summary>Transcript of the clip (${transcript.rows.length} lines)</summary>\n\n${full.length > 30000 ? full.slice(0, 30000) + '\n…(cut)' : full}\n</details>`);
    return o.join('\n') + '\n';
}

// ── the whole thing ──────────────────────────────────────────────────────────────────────────────────────────

/** @returns {{ data: Array, report: string, item: Object|null, transcriptText: string }} */
async function followUp(data, { ai, target, url, start, duration, speaker, dryRun = false }) {
    if (!ai || !ai.available) throw new Error('GEMINI_API_KEY is not set: the video follow-up needs it (see docs/CONTENT-AGENT.md)');
    const hit = findBlock(data, target);
    if (!hit) throw new Error(`cannot find block ${target} in data.json (write a block label like A-11.2)`);
    const window = clipWindow({ url, start, duration });
    const context = contextFor(data, hit);
    const transcript = await transcribe(ai, window);
    const extracted = await extractPoints(ai, context, transcript.rows, speaker);
    const transcriptText = transcript.rows.map((r) => `${mmss(r.sec)}  ${r.text}`).join('\n');
    if (!extracted.points.length) {
        return { data, item: null, transcriptText, report: renderReport({ hit, window, transcript, extracted, context, model: ai.model, item: null, dryRun }) };
    }
    const built = buildFollowUp(data, hit, window, extracted, speaker);
    return { data: built.data, item: built.item, transcriptText, report: renderReport({ hit, window, transcript, extracted, context, model: ai.model, item: built.item, dryRun }) };
}

module.exports = { mmss, clipWindow, videoParts, tsToSeconds, normalizeTranscript, transcribe, contextFor, extractPoints, buildFollowUp, renderReport, followUp };

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { dryRun: false, data: DATA_PATH };
    const keys = { '--target': 'target', '--url': 'url', '--start': 'start', '--duration': 'duration', '--speaker': 'speaker', '--report': 'report', '--transcript-out': 'transcriptOut', '--model': 'model' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--data') args.data = path.resolve(argv[++i]);
        else if (keys[a]) args[keys[a]] = argv[++i];
        else throw new Error(`Unknown option: ${a}`);
    }
    if (!args.target || !args.url) throw new Error('give --target A-11.2 and --url <YouTube link>');
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const raw = fs.readFileSync(args.data, 'utf8');
    const ai = createGemini({ model: args.model });
    const r = await followUp(JSON.parse(raw), { ai, ...args });
    ai.printUsage();
    console.log(r.report);
    if (args.report) fs.writeFileSync(args.report, r.report);
    if (args.transcriptOut) fs.writeFileSync(args.transcriptOut, r.transcriptText + '\n');
    const wrote = !args.dryRun && r.item;
    if (wrote) fs.writeFileSync(args.data, JSON.stringify(r.data, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    else console.log(args.dryRun ? '(dry run: data.json not written)' : '(nothing to add: data.json not written)');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${Boolean(wrote)}\n`);
}

if (require.main === module) {
    main().catch((e) => { console.error(`video-followup: ${e.message}`); process.exit(1); });
}
