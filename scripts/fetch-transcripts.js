#!/usr/bin/env node
// scripts/fetch-transcripts.js — keeps a transcript of every linked video in the
// repo (assets/transcripts/<videoId>.json), so the assistant can find the moment
// in a video that a question is about (see src/ai/video-nav.js).
//
//   node scripts/fetch-transcripts.js                     fetch transcripts for videos that have none yet
//   node scripts/fetch-transcripts.js --check             no network: list videos without one, exit 1 if any
//   node scripts/fetch-transcripts.js --reindex           rebuild assets/transcripts/index.json from the files there
//   node scripts/fetch-transcripts.js --import-whisper <videoId> <whisper.json> [--lang kn]
//                                                         add a transcript made with Whisper (see below)
//   options: --ids a,b,c            only these videos        --force   fetch everything again
//            --retry-unavailable    look again at videos recorded as having no captions
//            --langs hi-orig,kn-orig,en-orig   the spoken-language machine captions to try, best first
//            --alt-langs kn,en      extra machine-TRANSLATED tracks to keep for matching ("none" = skip them)
//            --cookies-from-browser edge       use your browser's YouTube login (if YouTube answers "sign in" or refuses requests)
//            --verbose              show what yt-dlp says for every request (to see why something failed)
//            --yt-dlp <path>        yt-dlp program to run (default: yt-dlp)
//   npm run transcripts                                    same as the first line
//
// Free, and nothing to install in the project: captions come from yt-dlp
// (https://github.com/yt-dlp/yt-dlp, open source; on Windows download the single yt-dlp.exe).
// Needs Node 18+.
//
// Tracks per video (what YouTube calls them):
//   1. The main track, in the language that is SPOKEN. Captions someone uploaded (kn, hi, en) win;
//      otherwise YouTube's own recognition in the spoken language ("hi-orig", "kn-orig", "en-orig").
//      Its words are the real thing the speaker said (as well as a machine heard it).
//   2. Extra tracks, by default Kannada and English: YouTube's machine TRANSLATION of the main track.
//      They are rougher, and exist so that a question asked in Kannada or English has words to match
//      in a video that is spoken in Hindi. They are marked source "translated" and the page says so.
//
// The run goes in two phases, and saves after every video (Ctrl-C is safe): first the main track of every video that
// has none, then the translated extras. YouTube refuses subtitle requests that come too fast (HTTP 429, which yt-dlp
// only prints as a warning), so there is a pause between requests and the run stops at the first refusal instead of
// hammering; rerun later and it asks only for what is missing. A refusal is never recorded as "no captions".
//
// What to expect, honestly:
//   * Most of the book's videos are in Hindi, which YouTube recognises reasonably. For the few Kannada ones it may
//     have no captions at all; a video with none is recorded in assets/transcripts/unavailable.json so it
//     isn't retried on every run (--retry-unavailable looks again).
//   * YouTube's translated tracks are rough (Kannada especially) and often refused. Better ones can be made with Gemini:
//     node scripts/translate-transcripts.js (free key; see docs/AI.md). A language that already has a track is not asked
//     for again. Note: --force fetches the spoken track again and drops the translated tracks of that video, because their
//     cues would no longer line up with the new ones.
//   * Translated tracks are sometimes refused by YouTube (HTTP 429, "too many requests"). The script then says so,
//     keeps what it has, and does NOT mark the video as done: run it again later (or with --cookies-from-browser).
//   * Sanskrit/Prakrit shlokas are mis-heard by every automatic system. For the ones that matter, write a mark
//     by hand in data.json: `videos[].marks: [{ "t": "12:34", "label": "Veeranatha shloka" }]`.
//   * Free fallback for a video with no usable captions: Whisper (open source, runs on your computer):
//         whisper video.mp3 --language kn --model medium --output_format json
//         node scripts/fetch-transcripts.js --import-whisper <videoId> video.json --lang kn
//
// File format (compact on purpose: one array per cue):
//   { "videoId": "...", "lang": "hi-orig", "source": "captions"|"manual"|"whisper", "fetched": "2026-11-19",
//     "altChecked": "2026-11-19",
//     "segments": [[startSeconds, "text"], ...],
//     "alt": [ { "lang": "kn", "source": "translated", "segments": [[startSeconds, "text"], ...] } ] }
// index.json lists what exists: { "<videoId>": { "lang", "source", "cues", "minutes", "alt": ["kn", "en"] } }.
// The page reads index.json first so it never asks for the many videos that have none.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = path.join(__dirname, '..');
const DEFAULT_DATA_FILE = 'assets/data.json';
const TRANSCRIPT_DIR = 'assets/transcripts';
const MANUAL_LANGS = ['kn', 'hi', 'en'];                       // captions someone uploaded
const DEFAULT_LANGS = ['hi-orig', 'kn-orig', 'en-orig'];       // YouTube's own recognition, in the spoken language
const DEFAULT_ALT_LANGS = ['kn', 'en'];                        // machine translations kept for matching
const MIN_CUE_SECONDS = 5;     // tiny caption lines are joined up to about this length (smaller files)
const PAUSE_MS = 3000;         // between requests to YouTube: be gentle, it refuses subtitle requests that come too fast (POOJA_PAUSE_MS overrides, for tests)
const SPECIAL_FILES = new Set(['index.json', 'unavailable.json']);
const VIDEO_ID = /^[\w-]{11}$/;

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/** Every distinct video id in data.json, in order of first use. */
function collectVideoIds(data) {
    const ids = [];
    const add = id => { if (VIDEO_ID.test(id || '') && !ids.includes(id)) ids.push(id); };
    for (const item of data || []) {
        for (const block of item.blocks || []) {
            for (const v of block.videos || []) {
                if (v && VIDEO_ID.test(v.youtubeId || '')) { add(v.youtubeId); continue; }
                const m = String(v?.url || '').match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/v\/)([\w-]{11})/);
                if (m) add(m[1]);
            }
        }
    }
    return ids;
}

/** Joins cues that are very short into longer ones (about `minSeconds`), keeping the first one's start. */
function mergeShort(segments, minSeconds = MIN_CUE_SECONDS) {
    const out = [];
    for (const seg of segments) {
        const last = out[out.length - 1];
        if (last && seg[0] - last[0] < minSeconds) last[1] = `${last[1]} ${seg[1]}`;
        else out.push([seg[0], seg[1]]);
    }
    return out;
}

/** YouTube's "json3" caption file -> [[startSeconds, text], ...]. Empty cues and immediate repeats are dropped. */
function parseJson3(json) {
    const out = [];
    for (const ev of (json && json.events) || []) {
        if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') continue;
        const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const start = Math.floor(ev.tStartMs / 1000);
        const prev = out[out.length - 1];
        if (prev && prev[1] === text) continue;
        out.push([start, text]);
    }
    return mergeShort(out);
}

/** Whisper's JSON output ({ language, segments: [{ start, end, text }] }) -> [[startSeconds, text], ...]. */
function fromWhisper(json) {
    const out = [];
    for (const seg of (json && json.segments) || []) {
        const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
        const start = Number(seg.start);
        if (text && Number.isFinite(start) && start >= 0) out.push([Math.floor(start), text]);
    }
    return mergeShort(out);
}

/**
 * Of the caption files yt-dlp wrote for a video (<id>.<lang>.json3), the one in the best language.
 * @param {string[]} files  file names
 * @param {string} id
 * @param {string[]} prefs  language codes, best first
 * @returns {{file: string, lang: string} | null}
 */
function pickSubtitleFile(files, id, prefs) {
    const found = [];
    for (const file of files) {
        const m = file.match(/^(.+?)\.(.+)\.json3$/);
        if (m && m[1] === id) found.push({ file, lang: m[2] });
    }
    for (const pref of prefs) {
        const hit = found.find(f => f.lang === pref);
        if (hit) return hit;
    }
    return found[0] || null;
}

/** A transcript file's content as stored. `alt` (extra translated tracks) and `altChecked` are left out when empty. */
function makeTranscript({ videoId, lang, source, segments, fetched, alt, altChecked }) {
    const t = { videoId, lang, source, fetched };
    if (altChecked) t.altChecked = altChecked;
    t.segments = segments;
    if (alt && alt.length) t.alt = alt;
    return t;
}

const validCues = list => (Array.isArray(list) ? list.filter(s => Array.isArray(s) && Number.isFinite(s[0]) && typeof s[1] === 'string') : []);

/** index.json content from the transcript files in a folder. Broken files are left out (and named in `skipped`). */
function buildIndex(dir) {
    const index = {};
    const skipped = [];
    if (!fs.existsSync(dir)) return { index, skipped };
    for (const name of fs.readdirSync(dir).sort()) {
        if (!name.endsWith('.json') || SPECIAL_FILES.has(name)) continue;
        const id = name.slice(0, -5);
        try {
            const t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            const segs = validCues(t.segments);
            if (!VIDEO_ID.test(id) || !segs.length) { skipped.push(name); continue; }
            const alt = (Array.isArray(t.alt) ? t.alt : []).filter(a => a && typeof a.lang === 'string' && validCues(a.segments).length);
            index[id] = {
                lang: t.lang || '', source: t.source || 'captions', cues: segs.length,
                minutes: Math.round(segs[segs.length - 1][0] / 60),
                alt: alt.map(a => a.lang),
            };
        } catch (_) {
            skipped.push(name);
        }
    }
    return { index, skipped };
}

// ── Files ─────────────────────────────────────────────────────────────────

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeIndex(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const { index, skipped } = buildIndex(dir);
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    return { count: Object.keys(index).length, skipped };
}

function writeTranscript(dir, transcript) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${transcript.videoId}.json`), JSON.stringify(transcript) + '\n');
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pauseMs = () => (process.env.POOJA_PAUSE_MS !== undefined ? Number(process.env.POOJA_PAUSE_MS) || 0 : PAUSE_MS);
const baseLang = code => String(code).split('-')[0];
/** The languages a transcript's translated tracks are in, reduced to the base code (en-US counts as en). */
const presentLangs = t => new Set((t.alt || []).map(a => baseLang((a && a.lang) || '')));

// ── yt-dlp ────────────────────────────────────────────────────────────────

function haveYtDlp(bin) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
}

const NOISE = /JavaScript runtime|\bEJS\b/i;                                   // yt-dlp says this on every run
const EMPTY_RESULT = /no subtitles for the requested|There are no subtitles/i;  // a normal "nothing there"
const PERMANENT = /Video unavailable|Private video|has been removed|account.*terminated|no longer available|not available/i;

/**
 * One yt-dlp run: either the captions someone uploaded (`auto: false`) or YouTube's machine ones (`auto: true`),
 * in the given languages. Returns { lang, segments } when it got something, otherwise
 * { none: true, rateLimited, permanent, error }: `error` is yt-dlp's own last complaint (empty when it simply had
 * nothing to give). yt-dlp reports a refused subtitle download (HTTP 429) as a WARNING, not an error, so warnings
 * are read too: a refusal must never look like "this video has no captions".
 */
function runYtDlp(bin, id, { auto, langs, cookies, verbose }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pooja-subs-'));
    try {
        const args = [
            '--skip-download', '--no-playlist', '--quiet',
            auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', langs.join(','), '--sub-format', 'json3',
            '--output', path.join(tmp, '%(id)s.%(ext)s'),
        ];
        if (cookies) args.push('--cookies-from-browser', cookies);
        args.push(`https://www.youtube.com/watch?v=${id}`);
        const r = spawnSync(bin, args, { encoding: 'utf8' });
        if (r.error) throw r.error;
        const lines = (r.stderr || '').split('\n').map(l => l.trim()).filter(l => l && !NOISE.test(l));
        if (verbose) lines.forEach(l => console.log(`      yt-dlp (${auto ? 'auto' : 'uploaded'} ${langs.join(',')}): ${l}`));
        const rateLimited = lines.some(l => /\b429\b|too many requests/i.test(l));
        const trouble = lines.filter(l => /^(ERROR|WARNING)/i.test(l) && !EMPTY_RESULT.test(l));
        const error = trouble[trouble.length - 1] || '';
        const pick = pickSubtitleFile(fs.readdirSync(tmp), id, langs);
        if (!pick) return { none: true, rateLimited, permanent: PERMANENT.test(error), error };
        const segments = parseJson3(JSON.parse(fs.readFileSync(path.join(tmp, pick.file), 'utf8')));
        return segments.length ? { lang: pick.lang, segments } : { none: true, rateLimited: false, permanent: false, error: '' };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** The main track: uploaded captions first, otherwise YouTube's own recognition in the spoken language. */
async function fetchMainTrack(bin, id, { langs, cookies, verbose }) {
    const manual = runYtDlp(bin, id, { auto: false, langs: MANUAL_LANGS, cookies, verbose });
    if (!manual.none) return { lang: manual.lang, source: 'manual', segments: manual.segments };
    if (manual.permanent || manual.rateLimited) return manual;
    await sleep(pauseMs());
    const auto = runYtDlp(bin, id, { auto: true, langs, cookies, verbose });
    if (!auto.none) return { lang: auto.lang, source: 'captions', segments: auto.segments };
    return { none: true, rateLimited: auto.rateLimited, permanent: auto.permanent, error: auto.error || manual.error };
}

/** The extra translated tracks. Stops at the first refusal from YouTube and says so; what it got is kept. */
async function fetchAltTracks(bin, id, { altLangs, mainLang, cookies, verbose }) {
    const alt = [];
    let rateLimited = false;
    let error = '';
    for (const lang of altLangs) {
        if (baseLang(lang) === baseLang(mainLang)) continue;       // the main track already is that language
        await sleep(pauseMs());
        const r = runYtDlp(bin, id, { auto: true, langs: [lang], cookies, verbose });
        if (!r.none) alt.push({ lang, source: 'translated', segments: r.segments });
        else if (r.rateLimited) { rateLimited = true; error = r.error; break; }
        else if (r.error) error = r.error;
    }
    return { alt, rateLimited, error };
}

// ── Main ──────────────────────────────────────────────────────────────────

const LIST_FLAGS = ['--check', '--reindex', '--force', '--retry-unavailable', '--verbose', '--help'];
const VALUE_FLAGS = ['--ids', '--langs', '--alt-langs', '--lang', '--import-whisper', '--yt-dlp', '--cookies-from-browser'];

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (LIST_FLAGS.includes(a)) args[a.slice(2)] = true;
        else if (VALUE_FLAGS.includes(a)) args[a.slice(2)] = argv[++i];
        else args._.push(a);
    }
    return args;
}

const splitList = text => String(text).split(',').map(s => s.trim()).filter(Boolean);

async function main(argv = process.argv.slice(2), root = DEFAULT_ROOT) {
    const args = parseArgs(argv);
    const dir = path.join(root, TRANSCRIPT_DIR);
    const unavailableFile = path.join(dir, 'unavailable.json');

    if (args.help) {
        console.log('See the comment at the top of scripts/fetch-transcripts.js for usage.');
        return 0;
    }

    if (args.reindex) {
        const { count, skipped } = writeIndex(dir);
        console.log(`index.json: ${count} transcript(s).`);
        if (skipped.length) console.warn(`Left out (not a valid transcript): ${skipped.join(', ')}`);
        return 0;
    }

    if (args['import-whisper']) {
        const id = args['import-whisper'];
        const file = args._[0];
        if (!VIDEO_ID.test(id) || !file) { console.error('Usage: --import-whisper <videoId> <whisper.json> [--lang kn]'); return 2; }
        const json = readJson(path.resolve(file), null);
        const segments = fromWhisper(json);
        if (!segments.length) { console.error(`No usable segments in ${file}.`); return 1; }
        // Keep any translated tracks the video already has: they are about the same speech.
        const existing = readJson(path.join(dir, `${id}.json`), {});
        writeTranscript(dir, makeTranscript({
            videoId: id, lang: args.lang || json.language || '', source: 'whisper', segments, fetched: today(),
            alt: existing.alt, altChecked: existing.altChecked,
        }));
        const { count } = writeIndex(dir);
        console.log(`Saved ${segments.length} cues for ${id} (source: whisper). ${count} transcript(s) in the index.`);
        return 0;
    }

    const data = readJson(path.join(root, DEFAULT_DATA_FILE), null);
    if (!Array.isArray(data)) { console.error(`Cannot read ${DEFAULT_DATA_FILE}.`); return 1; }
    const wanted = args.ids ? splitList(args.ids) : collectVideoIds(data);
    const unavailable = readJson(unavailableFile, {});
    const fileOf = id => path.join(dir, `${id}.json`);
    const have = id => fs.existsSync(fileOf(id));
    const altLangs = args['alt-langs'] === undefined ? DEFAULT_ALT_LANGS : (args['alt-langs'] === 'none' ? [] : splitList(args['alt-langs']));
    // A video needs the extras when YouTube was not asked yet AND some wanted language has no track. Tracks made with
    // Gemini (scripts/translate-transcripts.js) count as present, so this script does not go and ask YouTube for them.
    const needsExtras = id => {
        if (!have(id) || !altLangs.length) return false;
        const t = readJson(fileOf(id), {});
        if (t.altChecked) return false;
        const has = presentLangs(t);
        return altLangs.some(l => baseLang(l) !== baseLang(t.lang) && !has.has(baseLang(l)));
    };

    // Phase 1 fetches the main track of every video that has none. Phase 2 then adds the translated extras to every video
    // that lacks them (also ones fetched by an earlier run, or only partly filled because YouTube refused some).
    // Main tracks go first because they matter most and YouTube is quickest to refuse the translated ones.
    const fullJobs = wanted.filter(id => args.force || (!have(id) && (args['retry-unavailable'] || !unavailable[id])));

    if (args.check) {
        const missing = wanted.filter(id => !have(id));
        console.log(`${wanted.length - missing.length} of ${wanted.length} videos have a transcript.`);
        missing.forEach(id => console.log(`  missing: ${id}${unavailable[id] ? `  (no captions found: ${unavailable[id].why || 'no reason recorded'})` : ''}`));
        const withoutExtras = wanted.filter(needsExtras);
        if (withoutExtras.length) console.log(`${withoutExtras.length} of them could still get Kannada/English translated tracks (run the script without --check).`);
        return missing.length ? 1 : 0;
    }

    if (!fullJobs.length && !wanted.some(needsExtras)) { console.log('Nothing to fetch.'); writeIndex(dir); return 0; }

    const bin = args['yt-dlp'] || 'yt-dlp';
    if (!haveYtDlp(bin)) {
        console.error('yt-dlp was not found. It is free: https://github.com/yt-dlp/yt-dlp#installation (on Windows, download yt-dlp.exe and pass its path with --yt-dlp).');
        console.error('Without it you can still add transcripts made with Whisper (--import-whisper) or write marks by hand in data.json.');
        return 1;
    }

    const langs = args.langs ? splitList(args.langs) : DEFAULT_LANGS;
    const cookies = args['cookies-from-browser'];
    const verbose = !!args.verbose;
    const opts = { cookies, verbose };
    const persist = () => {                       // after every video: stopping with Ctrl-C loses nothing
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(unavailableFile, JSON.stringify(unavailable, null, 2) + '\n');
        return writeIndex(dir);
    };
    let saved = 0;
    let troubled = 0;
    let stopped = false;

    // ── Phase 1: main tracks
    for (let i = 0; i < fullJobs.length && !stopped; i++) {
        const id = fullJobs[i];
        process.stdout.write(`[main ${i + 1}/${fullJobs.length}] ${id} ... `);
        try {
            const main = await fetchMainTrack(bin, id, { langs, ...opts });
            if (!main.none) {
                writeTranscript(dir, makeTranscript({ videoId: id, lang: main.lang, source: main.source, segments: main.segments, fetched: today() }));
                delete unavailable[id];
                saved++;
                console.log(`${main.segments.length} cues (${main.lang}${main.source === 'manual' ? ', uploaded captions' : ''})`);
            } else if (main.rateLimited) {
                troubled++;
                stopped = true;
                console.log(`refused by YouTube (${main.error || 'HTTP 429'}); not recorded. Stopping: it refuses a request that comes too soon after another.`);
            } else if (main.error && !main.permanent) {
                troubled++;
                console.log(`failed (${main.error}); not recorded, run again later`);
            } else {
                unavailable[id] = { checked: today(), why: main.error || 'no captions in the wanted languages' };
                console.log(main.error ? `no captions (${main.error})` : 'no captions');
            }
        } catch (err) {
            troubled++;
            console.log(`failed (${err.message})`);
        }
        persist();
        if (i < fullJobs.length - 1 && !stopped) await sleep(pauseMs());
    }

    // ── Phase 2: translated extras
    const extraJobs = stopped ? [] : wanted.filter(needsExtras);
    for (let i = 0; i < extraJobs.length && !stopped; i++) {
        const id = extraJobs[i];
        process.stdout.write(`[extras ${i + 1}/${extraJobs.length}] ${id} ... `);
        try {
            const transcript = readJson(fileOf(id), null);
            const gotAlready = presentLangs(transcript);
            const r = await fetchAltTracks(bin, id, { altLangs: altLangs.filter(l => !gotAlready.has(baseLang(l))), mainLang: transcript.lang, ...opts });
            if (r.alt.length) transcript.alt = [...(transcript.alt || []), ...r.alt];
            if (!r.rateLimited && !r.error) transcript.altChecked = today();
            writeTranscript(dir, transcript);
            if (r.rateLimited) {
                troubled++;
                stopped = true;
                console.log(`extras refused by YouTube (${r.error || 'HTTP 429'}); got ${r.alt.map(a => a.lang).join(', ') || 'none'}; run again later`);
            } else if (r.error) {
                troubled++;
                console.log(`extras: ${r.alt.map(a => `${a.lang} (${a.segments.length} cues)`).join(', ') || 'none'}; problem (${r.error}), run again later`);
            } else {
                console.log(`extras: ${r.alt.map(a => `${a.lang} (${a.segments.length} cues)`).join(', ') || 'none available'}`);
            }
        } catch (err) {
            troubled++;
            console.log(`failed (${err.message})`);
        }
        persist();
        if (i < extraJobs.length - 1 && !stopped) await sleep(pauseMs());
    }

    const { count } = persist();
    console.log(`Done: ${saved} new transcript(s); ${count} in the index; ${Object.keys(unavailable).length} video(s) without captions.`);
    if (stopped) console.log('YouTube refused a request, so the run stopped early. Nothing is lost: wait about an hour (or add --cookies-from-browser edge) and run the same command again; it only asks for what is still missing.');
    else if (troubled) console.log(`${troubled} request(s) had problems and were not recorded as "no captions"; run the same command again later, or add --verbose to see what yt-dlp says.`);
    return 0;
}

module.exports = {
    collectVideoIds, mergeShort, parseJson3, fromWhisper, pickSubtitleFile, buildIndex, makeTranscript, parseArgs, main,
    writeIndex, writeTranscript,
    TRANSCRIPT_DIR, DEFAULT_LANGS, DEFAULT_ALT_LANGS,
};

if (require.main === module) {
    main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
}
