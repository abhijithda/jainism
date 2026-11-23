#!/usr/bin/env node
// scripts/translate-transcripts.js — translates the spoken-language transcript of every video (mostly Hindi) into
// Kannada and English with Gemini, and stores the result as extra ("alt") tracks in the same file, so that a question
// asked in Kannada or English has words to match in a Hindi-spoken video (see src/ai/video-nav.js).
//
//   node scripts/translate-transcripts.js --dry-run            ONE video, first 30 cues: prints the Hindi next to the
//                                                              Kannada/English, writes nothing. Judge quality here first.
//   node scripts/translate-transcripts.js                      translate what is missing, save after every batch
//   node scripts/translate-transcripts.js --check              no network: what is done / partly done / still to do
//   options: --ids a,b,c            only these videos (with --dry-run: the video to show)
//            --langs kn,en          target languages (default kn,en; a video is never translated into its own language)
//            --cues 30              --dry-run only: how many cues to translate
//            --force                translate again even what is done
//            --batch 50             cues per request (a request that comes back wrong is split in half, down to 1 cue)
//            --pause 7000           milliseconds between requests (free keys allow only a few requests per minute)
//            --cooldown 65000       wait after a refusal (HTTP 429) before asking again
//            --max-429 3            refusals in a row before the run stops
//            --max-requests 0       stop after this many requests (0 = no limit): a way to spread the work over days
//            --model <name>         Gemini model (default: GEMINI_MODEL, else the default of scripts/lib/gemini.js)
//            --glossary <file>      Jain terms (default scripts/glossary.json)
//   npm run transcripts:translate -- --dry-run
//
// Free: a free key from Google AI Studio (https://aistudio.google.com/apikey) in the environment variable
// GEMINI_API_KEY. Nothing else to install. Google does not publish fixed free-tier limits any more and they differ per
// project: AI Studio's "rate limit" view shows yours. This script is built for the worst case: a few requests a
// minute, a daily cap, and a run that is stopped halfway. It stops cleanly on repeated 429s and a rerun continues.
//
// What it does to a transcript file (assets/transcripts/<videoId>.json):
//   * The main track (the spoken language) is never touched. For each target language it adds or fills
//       { "lang": "kn", "source": "translated", "via": "gemini", "model": "...", "segments": [[startSeconds, "text"], ...] }
//     in `alt`. Every alt cue has exactly the start second of one main cue, so a hit in the Kannada track opens the
//     video at the same second as the Hindi cue it was made from. A translated track replaces YouTube's own machine
//     translation of the same language, if one is there; other alt tracks are left alone.
//   * One request carries a batch of cues and asks for all target languages at once (half the requests of two passes).
//     Cues are sent as {i, t}; the answer must contain every i exactly once, a non-empty text for every language,
//     nothing unknown, and plausible lengths and scripts. Otherwise the WHOLE answer is thrown away and the batch is
//     split in half and asked again, down to a single cue. A cue that never comes back right is left out of the alt track
//     (so a gap, never a shifted timestamp) and is tried again on the next run.
//   * Faithful, not corrected: the prompt says to translate what the captions say, mistakes included, and to give back
//     unchanged any cue that is not intelligible speech (a Sanskrit/Prakrit shloka or mantra the recogniser garbled).
//   * Jain terms: scripts/glossary.json lists the Hindi spellings the captions may use and the Kannada/English spelling
//     to write. Only the entries that occur in a batch are sent with it.
//
// What this cannot check: that the Kannada is GOOD. Alignment is checked (ids, counts, scripts, lengths), meaning is
// not. Read the --dry-run output (ideally with someone who reads Kannada) before the full run.

'use strict';

const fs = require('fs');
const path = require('path');
const { createGemini } = require('./lib/gemini');
const { TRANSCRIPT_DIR, buildIndex, writeIndex, writeTranscript } = require('./fetch-transcripts');

const DEFAULT_ROOT = path.join(__dirname, '..');
const DEFAULT_GLOSSARY = 'scripts/glossary.json';
const LANG_NAME = { hi: 'Hindi', kn: 'Kannada', en: 'English' };
const DEFAULT_TARGETS = ['kn', 'en'];
const DEFAULT_BATCH = 50;
const DEFAULT_PAUSE_MS = 7000;
const DEFAULT_COOLDOWN_MS = 65000;
const DEFAULT_MAX_429 = 3;
const MAX_BAD_IN_A_ROW = 8;        // errors / wrong answers in a row before the run gives up (the model or network is not working)
const CONTEXT_CUES = 3;            // cues before a batch, sent as context only
const DRY_RUN_CUES = 30;
const DRY_RUN_ID = 'bgldj0TMZB4';  // a short video (32 cues), the one used to try the fetch script
const MIN_RATIO_CHARS = 12;        // shorter cues are not length-checked
const RATIO_RANGE = [0.2, 6];      // translated length / source length, in characters; a guard against gross mistakes only
const ID = /^[\w-]{11}$/;

// ── The prompt ───────────────────────────────────────────────────────────

const SYSTEM = `You translate automatic speech-recognition transcripts of Jain religious talks. The input is JSON: {"before":[...],"cues":[{"i":number,"t":"text"}]}. The cues are consecutive fragments of one talk, cut at arbitrary points (often in the middle of a sentence). "before" is the text just ahead of the first cue, for context only. Return JSON only: {"cues":[{"i":number, "<language code>":"translation", ...}]} with one field for each requested language code.
Rules:
1. Return exactly one object for every input cue, with the same "i". Never skip, merge, split, add or reorder cues. Never output "before".
2. Translate each cue by itself. Do not move words between cues; a cue that stops mid-sentence may have a translation that stops mid-sentence.
3. Translate faithfully. Do NOT correct, improve, summarise, explain or guess what the speaker "must have meant"; if the recogniser wrote something odd, translate what is written. Add no comments, notes or text that is not in the cue.
4. If a cue is not intelligible speech in the source language, because it is a Sanskrit or Prakrit shloka or mantra, or the recogniser garbled it, return that cue EXACTLY as given, character for character, in every requested field. If you are unsure but can make sense of it, translate it.
5. Kannada means Kannada script. English means plain English. Keep numbers as digits and English words that are already in the cue.
6. Names and Jain technical terms are not translated into their meaning. Use the glossary spelling when one is given. Otherwise write the Sanskrit-derived spelling in the target script (Kannada: for example ಅಭಿಷೇಕ; English: simple Latin letters without diacritics, for example Abhisheka).`;

/** Turns the glossary file's content into entries { hi: string[], kn?, en? } (NFC, bad entries dropped). */
function normalizeGlossary(raw) {
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.terms) ? raw.terms : []);
    const out = [];
    for (const e of list) {
        const hi = (Array.isArray(e && e.hi) ? e.hi : [e && e.hi]).filter(v => typeof v === 'string' && v.trim()).map(v => v.normalize('NFC').trim());
        const kn = typeof (e && e.kn) === 'string' && e.kn.trim() ? e.kn.trim() : undefined;
        const en = typeof (e && e.en) === 'string' && e.en.trim() ? e.en.trim() : undefined;
        if (hi.length && (kn || en)) out.push({ hi, kn, en });
    }
    return out;
}

function loadGlossary(file) {
    try { return normalizeGlossary(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (_) { return []; }
}

const WORD_SPLIT = /[\s,.;:!?।॥"'()\-\u2013\u2014]+/;

/** The glossary entries whose Hindi spelling occurs in the texts. A one-word spelling matches the start of a word (so
 *  "अभिषेक" also finds "अभिषेकों"); a spelling of several words must occur as written. Nukta forms are normalised. */
function termsFor(glossary, texts) {
    const joined = texts.join(' ').normalize('NFC');
    const words = joined.split(WORD_SPLIT).filter(Boolean);
    return glossary.filter(e => e.hi.some(v => (/\s/.test(v) ? joined.includes(v) : words.some(w => w.startsWith(v)))));
}

/** The user message for one batch: instructions, the glossary lines that apply, then the JSON payload as the LAST line. */
function buildPrompt({ source, targets, items, before, terms }) {
    const lines = [`Translate from ${LANG_NAME[source]} into ${targets.map(l => `${LANG_NAME[l]} (code "${l}")`).join(' and ')}. Give every cue a field for each of: ${targets.join(', ')}.`];
    if (terms && terms.length) {
        lines.push('Glossary (use these spellings):');
        for (const t of terms) {
            const to = targets.filter(l => t[l]).map(l => `${LANG_NAME[l]}: ${t[l]}`).join(' | ');
            if (to) lines.push(`${t.hi.join(' | ')} -> ${to}`);
        }
    }
    lines.push(JSON.stringify({ before, cues: items.map(it => ({ i: it.i, t: it.t })) }));
    return lines.join('\n');
}

// ── Checking an answer ───────────────────────────────────────────────────

const collapse = s => String(s).replace(/\s+/g, ' ').trim();
const HAS_KANNADA = /[\u0C80-\u0CFF]/;
const HAS_LATIN = /[A-Za-z]/;

/** Does `text` look like it is in `lang`? Giving a cue back unchanged (rule 4) is allowed. */
function scriptOk(lang, text, source) {
    if (collapse(text) === collapse(source)) return true;
    if (lang === 'kn') return HAS_KANNADA.test(text);
    if (lang === 'en') return HAS_LATIN.test(text);
    return true;
}

function ratioOk(source, text) {
    if (source.length < MIN_RATIO_CHARS) return true;
    const r = text.length / source.length;
    return r >= RATIO_RANGE[0] && r <= RATIO_RANGE[1];
}

/**
 * The model's answer for a batch -> { ok: true, out: Map(i -> { kn, en }) } or { ok: false, why }.
 * Strict on purpose: any unknown id, repeated id, missing cue, missing or empty language, wrong script or absurd length
 * rejects the whole answer, because one slip can mean the rest is shifted.
 */
function validateAnswer(answer, items, targets) {
    const list = Array.isArray(answer && answer.cues) ? answer.cues : (Array.isArray(answer) ? answer : null);
    if (!list) return { ok: false, why: 'the answer has no "cues" list' };
    const want = new Map(items.map(it => [it.i, it]));
    const out = new Map();
    for (const c of list) {
        if (!c || typeof c !== 'object' || !Number.isInteger(c.i) || !want.has(c.i)) return { ok: false, why: `unknown cue id ${c && c.i}` };
        if (out.has(c.i)) return { ok: false, why: `cue ${c.i} came back twice` };
        const rec = {};
        for (const lang of targets) {
            const text = typeof c[lang] === 'string' ? collapse(c[lang]) : '';
            const source = want.get(c.i).t;
            if (!text) return { ok: false, why: `cue ${c.i} has no ${lang}` };
            if (!scriptOk(lang, text, source)) return { ok: false, why: `cue ${c.i}: the ${lang} text is not in ${LANG_NAME[lang]}` };
            if (!ratioOk(source, text)) return { ok: false, why: `cue ${c.i}: the ${lang} length looks wrong` };
            rec[lang] = text;
        }
        out.set(c.i, rec);
    }
    if (out.size !== items.length) return { ok: false, why: `${items.length - out.size} of ${items.length} cue(s) missing` };
    return { ok: true, out };
}

// ── Asking, with splitting and stopping ──────────────────────────────────

const is429 = e => /\b429\b/.test(String((e && e.message) || e));
const isFatal = e => /Gemini answered 4\d\d/.test(String((e && e.message) || e)) && !is429(e);   // bad key, retired model ...: asking again will not help

/**
 * Translate cues, splitting a batch whose answer is wrong. Stops (ctx.stopped) on repeated 429s, a fatal error, a run of
 * bad answers or the request limit; whatever was answered right before that is kept.
 * @param {Object} ctx  { ai, source, targets, glossary, before(i) -> string[], log, sleep, pause, cooldown, max429,
 *                        maxRequests, requests, ... } (see makeContext)
 * @param {{i: number, t: string}[]} items
 * @param {(i: number, rec: Object) => void} [onCue]  called for every cue as soon as its batch is accepted
 * @returns {Promise<{ got: Map<number, Object>, failed: number[] }>}  failed: cues that never came back right
 */
async function translateCues(ctx, items, onCue) {
    const got = new Map();
    const failed = [];

    async function ask(group) {
        for (;;) {
            if (ctx.stopped) return null;
            if (ctx.maxRequests && ctx.requests >= ctx.maxRequests) { ctx.stopped = 'max-requests'; return null; }
            if ((ctx.requests > 0 || ctx.pauseFirst) && ctx.pause) await ctx.sleep(ctx.pause);
            ctx.requests++;
            const terms = termsFor(ctx.glossary, group.map(g => g.t));
            let answer;
            try {
                answer = await ctx.ai.json({
                    system: SYSTEM,
                    prompt: buildPrompt({ source: ctx.source, targets: ctx.targets, items: group, before: ctx.before(group[0].i), terms }),
                });
            } catch (e) {
                if (is429(e)) {
                    ctx.in429++;
                    if (ctx.in429 >= ctx.max429) { ctx.stopped = 'rate-limit'; return null; }
                    ctx.log(`      Google refused the request (HTTP 429, ${ctx.in429} of ${ctx.max429} in a row); waiting ${Math.round(ctx.cooldown / 1000)} s`);
                    await ctx.sleep(ctx.cooldown);
                    continue;                                     // the same group again
                }
                if (isFatal(e)) { ctx.stopped = 'fatal'; ctx.fatal = e.message; return null; }
                ctx.bad++;
                if (ctx.bad >= MAX_BAD_IN_A_ROW) { ctx.stopped = 'unreliable'; return null; }
                return { ok: false, why: e.message };
            }
            ctx.in429 = 0;
            const v = validateAnswer(answer, group, ctx.targets);
            if (v.ok) ctx.bad = 0;
            else { ctx.bad++; if (ctx.bad >= MAX_BAD_IN_A_ROW) { ctx.stopped = 'unreliable'; return null; } }
            return v;
        }
    }

    async function run(group) {
        let v = await ask(group);
        if (v && !v.ok && group.length === 1) v = await ask(group);        // a single cue gets one more try
        if (!v) return;                                                    // stopped
        if (v.ok) {
            for (const [i, rec] of v.out) { got.set(i, rec); if (onCue) onCue(i, rec); }
            return;
        }
        if (group.length === 1) {
            failed.push(group[0].i);
            ctx.log(`      cue ${group[0].i} did not come back right (${v.why}); left out, a rerun will try it again`);
            return;
        }
        ctx.log(`      a batch of ${group.length} came back wrong (${v.why}); asking again in two halves`);
        const mid = Math.ceil(group.length / 2);
        await run(group.slice(0, mid));
        await run(group.slice(mid));
    }

    const size = ctx.batch;
    for (let k = 0; k < items.length && !ctx.stopped; k += size) await run(items.slice(k, k + size));
    return { got, failed };
}

// ── Transcript files ─────────────────────────────────────────────────────

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const baseLang = code => String(code || '').split('-')[0];
const validCue = s => Array.isArray(s) && Number.isFinite(s[0]) && typeof s[1] === 'string' && s[1].trim() !== '';

/** The Gemini-translated cues of a language already in the file, as Map(index of the main cue -> text). Cues whose
 *  start is not a main cue's start (the main track was fetched again since) are ignored: they would be misaligned. */
function geminiMap(transcript, main, lang) {
    const map = new Map();
    const entry = (transcript.alt || []).find(a => a && a.lang === lang && a.via === 'gemini');
    if (!entry) return map;
    const byStart = new Map(main.map((c, i) => [c[0], i]));
    for (const seg of entry.segments || []) if (validCue(seg) && byStart.has(seg[0])) map.set(byStart.get(seg[0]), seg[1]);
    return map;
}

const segmentsOf = (main, map) => main.flatMap((c, i) => (map.has(i) ? [[c[0], map.get(i)]] : []));

/** What a transcript still needs: per target language, how many main cues have a Gemini translation. */
function statusOf(transcript, targets) {
    const main = (transcript.segments || []).filter(validCue);
    const source = baseLang(transcript.lang);
    return {
        source, cues: main.length,
        langs: targets.filter(l => l !== source).map(l => ({ lang: l, done: geminiMap(transcript, main, l).size })),
    };
}

/** Puts the translated cues into the file's `alt`: one track per language that has any, replacing a track of the same
 *  language, leaving every other track and every other field as they were. */
function withTracks(transcript, main, maps, model) {
    const alt = [...(transcript.alt || [])];
    for (const [lang, map] of maps) {
        if (!map.size) continue;
        const at = alt.findIndex(a => a && a.lang === lang);
        const was = at >= 0 && alt[at].via === 'gemini' ? alt[at].model : '';
        const entry = { lang, source: 'translated', via: 'gemini', model: was && was !== model && !was.split(', ').includes(model) ? `${was}, ${model}` : model, segments: segmentsOf(main, map) };
        if (at >= 0) alt[at] = entry; else alt.push(entry);
    }
    return { ...transcript, alt };
}

// ── Output helpers ───────────────────────────────────────────────────────

const clock = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

const HINTS = {
    'rate-limit': 'Google refused several requests in a row (HTTP 429). If this is the per-minute limit, wait a few minutes; if it is the daily cap it resets at midnight Pacific time. Run the same command again: it continues where it stopped and asks only for what is missing. (AI Studio\'s "rate limit" view shows your limits; --pause 12000 asks more slowly.)',
    'max-requests': 'Stopped at --max-requests. Run the same command again to continue.',
    unreliable: 'Stopped: several requests in a row failed or came back wrong, so the model or the network is not working right now. The reasons are printed above. Nothing is lost; try again later.',
};

function parseArgs(argv) {
    const flags = ['--dry-run', '--check', '--force', '--help'];
    const values = ['--ids', '--langs', '--cues', '--batch', '--pause', '--cooldown', '--max-429', '--max-requests', '--model', '--glossary'];
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (flags.includes(a)) args[a.slice(2)] = true;
        else if (values.includes(a)) args[a.slice(2)] = argv[++i];
        else args._.push(a);
    }
    return args;
}

const splitList = text => String(text).split(',').map(s => s.trim()).filter(Boolean);
const wholeNumber = (v, fallback, min = 0) => (v === undefined ? fallback : (/^\d+$/.test(String(v)) && Number(v) >= min ? Number(v) : NaN));

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @param {string} root  project root
 * @param {{ ai?: Object, sleep?: Function, log?: Function, error?: Function }} [deps]  the model client, the clock and the output; tests pass fakes
 */
async function main(argv = process.argv.slice(2), root = DEFAULT_ROOT, deps = {}) {
    const log = deps.log || console.log;
    const error = deps.error || console.error;
    const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const args = parseArgs(argv);

    if (args.help) { log('See the comment at the top of scripts/translate-transcripts.js for usage.'); return 0; }

    const targets = args.langs ? splitList(args.langs) : DEFAULT_TARGETS;
    const nums = {
        batch: wholeNumber(args.batch, DEFAULT_BATCH, 1), pause: wholeNumber(args.pause, DEFAULT_PAUSE_MS), cooldown: wholeNumber(args.cooldown, DEFAULT_COOLDOWN_MS),
        max429: wholeNumber(args['max-429'], DEFAULT_MAX_429, 1), maxRequests: wholeNumber(args['max-requests'], 0), cues: wholeNumber(args.cues, DRY_RUN_CUES, 1),
    };
    const badNum = Object.entries(nums).find(([, v]) => Number.isNaN(v));
    if (!targets.length || targets.some(l => !['kn', 'en', 'hi'].includes(l)) || badNum) {
        error(badNum ? `Bad value for --${badNum[0]}: it must be a whole number.` : 'Bad --langs: use kn, en or kn,en.');
        return 2;
    }

    const dir = path.join(root, TRANSCRIPT_DIR);
    const fileOf = id => path.join(dir, `${id}.json`);
    let ids = Object.keys(buildIndex(dir).index).sort();
    if (args.ids) {
        const wanted = splitList(args.ids);
        wanted.filter(id => !ids.includes(id)).forEach(id => log(`No transcript for ${id}: skipped.`));
        ids = wanted.filter(id => ids.includes(id));
    }

    // ── --check: no network
    if (args.check) {
        let left = 0;
        for (const id of ids) {
            const st = statusOf(readJson(fileOf(id), {}), targets);
            const parts = st.langs.map(l => `${l.lang} ${l.done}/${st.cues}`);
            const open = st.langs.some(l => l.done < st.cues);
            if (open) left++;
            log(`${open ? 'todo  ' : 'done  '} ${id}  (${st.source}, ${st.cues} cues)  ${parts.join(', ') || 'nothing to translate'}`);
        }
        log(`${ids.length - left} of ${ids.length} videos fully translated into ${targets.join(' and ')}.`);
        return left ? 1 : 0;
    }

    const ai = deps.ai || createGemini({ model: args.model, retries: 1 });
    if (!ai.available) {
        error('GEMINI_API_KEY is not set. It is free: create a key in Google AI Studio (https://aistudio.google.com/apikey) and set it, e.g. in PowerShell: $env:GEMINI_API_KEY = "...".');
        return 1;
    }
    const glossary = loadGlossary(path.resolve(root, args.glossary || DEFAULT_GLOSSARY));
    const dry = !!args['dry-run'];

    const makeContext = (source, main, to) => ({
        ai, source, targets: to, glossary, log, sleep, requests: 0,
        pause: nums.pause, cooldown: nums.cooldown, max429: nums.max429, maxRequests: dry ? 0 : nums.maxRequests, batch: nums.batch,
        before: i => main.slice(Math.max(0, i - CONTEXT_CUES), i).map(c => c[1]),
        in429: 0, bad: 0, stopped: '', fatal: '', pauseFirst: false,
    });

    // ── --dry-run: one video, nothing written
    if (dry) {
        const id = ids.includes(args.ids && splitList(args.ids)[0]) ? splitList(args.ids)[0] : (!args.ids && ids.includes(DRY_RUN_ID) ? DRY_RUN_ID : ids[0]);
        if (!id) { error('No transcript to try. Fetch some first: node scripts/fetch-transcripts.js'); return 1; }
        const transcript = readJson(fileOf(id), {});
        const main = (transcript.segments || []).filter(validCue);
        const source = baseLang(transcript.lang);
        const to = targets.filter(l => l !== source);
        if (!LANG_NAME[source] || !to.length) { error(`${id}: nothing to translate (spoken language "${transcript.lang}").`); return 1; }
        const items = main.slice(0, nums.cues).map((c, i) => ({ i, t: c[1] }));
        log(`Dry run: ${id}, ${LANG_NAME[source]} -> ${to.map(l => LANG_NAME[l]).join(' + ')}, the first ${items.length} of ${main.length} cues, model ${ai.model || 'unknown'}. Nothing is written.`);
        const terms = termsFor(glossary, items.map(it => it.t));
        log(`Glossary entries sent: ${terms.length ? terms.map(t => t.hi[0]).join(', ') : 'none'}.\n`);
        const ctx = makeContext(source, main, to);
        const { got, failed } = await translateCues(ctx, items);
        for (const it of items) {
            const rec = got.get(it.i);
            log(`[${clock(main[it.i][0])}] ${source.toUpperCase()}  ${it.t}`);
            if (rec) to.forEach(l => log(`        ${l.toUpperCase()}  ${rec[l]}`));
            else log('        (not translated)');
        }
        log(`\n${got.size} of ${items.length} cues translated in ${ctx.requests} request(s); ${failed.length} left out.`);
        if (ctx.stopped === 'fatal') { error(`Gemini refused: ${ctx.fatal}. If the model name is the problem, set GEMINI_MODEL or use --model.`); return 1; }
        if (ctx.stopped) log(HINTS[ctx.stopped]);
        return 0;
    }

    // ── The run
    const model = ai.model || 'unknown';
    log(`Model: ${model}. Targets: ${targets.join(', ')}. ${glossary.length} glossary term(s).`);
    let videosDone = 0;
    let cuesDone = 0;
    let requests = 0;
    let stopped = '';
    let fatal = '';
    let openVideos = 0;

    for (let n = 0; n < ids.length && !stopped; n++) {
        const id = ids[n];
        const tag = `[${n + 1}/${ids.length}] ${id}`;
        let transcript = readJson(fileOf(id), null);
        const main = ((transcript && transcript.segments) || []).filter(validCue);
        const source = baseLang(transcript && transcript.lang);
        if (!main.length || !LANG_NAME[source]) { log(`${tag}: skipped (spoken language "${transcript && transcript.lang}")`); continue; }
        const to = targets.filter(l => l !== source);
        if (!to.length) { log(`${tag}: nothing to translate (spoken language ${source})`); continue; }

        const maps = new Map(to.map(l => [l, args.force ? new Map() : geminiMap(transcript, main, l)]));
        const needed = to.filter(l => maps.get(l).size < main.length);
        if (!needed.length) { log(`${tag}: already translated`); continue; }
        const items = main.map((c, i) => ({ i, t: c[1] })).filter(it => needed.some(l => !maps.get(l).has(it.i)));
        log(`${tag} (${source}, ${main.length} cues): ${needed.join('+')}, ${items.length} cue(s) to translate`);

        const ctx = makeContext(source, main, needed);
        ctx.maxRequests = nums.maxRequests ? Math.max(0, nums.maxRequests - requests) : 0;
        if (nums.maxRequests && ctx.maxRequests === 0) { stopped = 'max-requests'; break; }
        ctx.pauseFirst = requests > 0;                        // a pause between videos too, not only inside one
        let sinceSave = 0;
        const save = () => {
            transcript = withTracks(transcript, main, maps, model);
            writeTranscript(dir, transcript);
            writeIndex(dir);
            sinceSave = 0;
        };
        const result = await translateCues(ctx, items, (i, rec) => {
            for (const l of needed) if (!maps.get(l).has(i)) maps.get(l).set(i, rec[l]);   // a cue already translated stays as it was
            sinceSave++;
        });
        if (sinceSave) save();                                // saved after every video, and whatever came before a stop
        requests += ctx.requests;
        cuesDone += result.got.size;
        const missing = Math.max(...to.map(l => main.length - maps.get(l).size));
        if (missing > 0) openVideos++; else videosDone++;
        log(`    ${result.got.size} cue(s) translated${missing ? `, ${missing} still missing` : ''}`);
        if (ctx.stopped) { stopped = ctx.stopped; fatal = ctx.fatal; }
    }

    const { count } = writeIndex(dir);
    log(`Done: ${videosDone} video(s) complete, ${openVideos} with cues still missing, ${cuesDone} cue(s) translated, ${requests} request(s); ${count} transcript(s) in the index.`);
    if (stopped === 'fatal') { error(`Gemini refused: ${fatal}. If the model name is the problem, set GEMINI_MODEL or use --model.`); return 1; }
    if (stopped) log(HINTS[stopped]);
    else if (openVideos) log('Some cues never came back right (listed above). Run the same command again to retry just those.');
    return 0;
}

module.exports = {
    main, parseArgs, normalizeGlossary, loadGlossary, termsFor, buildPrompt, validateAnswer, translateCues,
    geminiMap, segmentsOf, statusOf, withTracks, SYSTEM, DEFAULT_BATCH, DEFAULT_GLOSSARY,
};

if (require.main === module) {
    main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
}
