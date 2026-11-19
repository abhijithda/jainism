#!/usr/bin/env node
// scripts/fetch-transcripts.js — keeps a transcript of every linked video in the
// repo (assets/transcripts/<videoId>.json), so the assistant can find the moment
// in a video that a question is about (see src/ai/video-nav.js).
//
//   node scripts/fetch-transcripts.js                     fetch captions for videos that have no transcript yet
//   node scripts/fetch-transcripts.js --check             no network: list videos without one, exit 1 if any
//   node scripts/fetch-transcripts.js --reindex           rebuild assets/transcripts/index.json from the files there
//   node scripts/fetch-transcripts.js --import-whisper <videoId> <whisper.json> [--lang kn]
//                                                         add a transcript made with Whisper (see below)
//   options: --ids a,b,c   only these videos      --force   fetch again even if present
//            --retry-unavailable   look again at videos recorded as having no captions
//            --langs kn,en,hi      caption languages to try, best first (default below)
//   npm run transcripts                                    same as the first line
//
// Free, and nothing to install in the project: captions come from yt-dlp
// (https://github.com/yt-dlp/yt-dlp, open source; `pip install yt-dlp` or the
// single .exe on Windows). Needs Node 18+.
//
// What to expect, honestly:
//   • YouTube makes automatic captions for only some languages. Kannada
//     pravachanas usually have NONE, and Sanskrit/Prakrit shlokas are mis-heard by
//     every automatic system. A video with no captions is recorded in
//     assets/transcripts/unavailable.json so it isn't retried on every run.
//   • For those, a free fallback is Whisper (open source, runs on your computer):
//         pip install openai-whisper
//         whisper video.mp3 --language kn --model medium --output_format json
//         node scripts/fetch-transcripts.js --import-whisper <videoId> video.json --lang kn
//     Check a few timestamps by listening before trusting it: Kannada recognition is
//     decent, not perfect. The assistant always shows the matching words under its
//     "Watch" button and says where they came from, so a wrong line is easy to spot.
//   • You can also write the moments you care about by hand, in data.json, as
//     `videos[].marks: [{ "t": "12:34", "label": "Veeranatha shloka" }]`. Those are
//     the most reliable of all and need no transcript.
//
// File format (compact on purpose: one array per cue):
//   { "videoId": "...", "lang": "kn", "source": "captions"|"whisper"|"manual",
//     "fetched": "2026-11-18", "segments": [[startSeconds, "text"], ...] }
// index.json lists what exists: { "<videoId>": { "lang", "source", "cues", "minutes" } }.
// The page reads index.json first so it never asks for the many videos that have none.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = path.join(__dirname, '..');
const DEFAULT_DATA_FILE = 'assets/data.json';
const TRANSCRIPT_DIR = 'assets/transcripts';
const DEFAULT_LANGS = ['kn', 'kn-orig', 'hi', 'hi-orig', 'en', 'en-orig'];
const MIN_CUE_SECONDS = 5;     // tiny caption lines are joined up to about this length (smaller files)
const PAUSE_MS = 1500;         // between videos: be gentle with YouTube
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

/** A transcript file's content as stored. */
function makeTranscript({ videoId, lang, source, segments, fetched }) {
    return { videoId, lang, source, fetched, segments };
}

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
            const segs = Array.isArray(t.segments) ? t.segments.filter(s => Array.isArray(s) && Number.isFinite(s[0]) && typeof s[1] === 'string') : [];
            if (!VIDEO_ID.test(id) || !segs.length) { skipped.push(name); continue; }
            index[id] = {
                lang: t.lang || '', source: t.source || 'captions', cues: segs.length,
                minutes: Math.round(segs[segs.length - 1][0] / 60),
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

// ── yt-dlp ────────────────────────────────────────────────────────────────

function haveYtDlp(bin) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
}

/** Runs yt-dlp for one video; returns { segments, lang } or null when it has no captions in the wanted languages. */
function fetchCaptions(bin, id, langs) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pooja-subs-'));
    try {
        const r = spawnSync(bin, [
            '--skip-download', '--no-playlist', '--quiet', '--no-warnings',
            '--write-subs', '--write-auto-subs', '--sub-langs', langs.join(','), '--sub-format', 'json3',
            '--output', path.join(tmp, '%(id)s.%(ext)s'),
            `https://www.youtube.com/watch?v=${id}`,
        ], { encoding: 'utf8' });
        if (r.error) throw r.error;
        const pick = pickSubtitleFile(fs.readdirSync(tmp), id, langs);
        if (!pick) {
            // A non-zero exit with no file may be a deleted/private video or a network problem: say which it looks like.
            const why = (r.stderr || '').trim().split('\n').pop() || '';
            return { none: true, why: r.status ? why : '' };
        }
        const segments = parseJson3(JSON.parse(fs.readFileSync(path.join(tmp, pick.file), 'utf8')));
        return segments.length ? { segments, lang: pick.lang } : { none: true, why: '' };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// ── Main ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (['--check', '--reindex', '--force', '--retry-unavailable', '--help'].includes(a)) args[a.slice(2)] = true;
        else if (['--ids', '--langs', '--lang', '--import-whisper', '--yt-dlp'].includes(a)) args[a.slice(2)] = argv[++i];
        else args._.push(a);
    }
    return args;
}

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
        writeTranscript(dir, makeTranscript({ videoId: id, lang: args.lang || json.language || '', source: 'whisper', segments, fetched: today() }));
        const { count } = writeIndex(dir);
        console.log(`Saved ${segments.length} cues for ${id} (source: whisper). ${count} transcript(s) in the index.`);
        return 0;
    }

    const data = readJson(path.join(root, DEFAULT_DATA_FILE), null);
    if (!Array.isArray(data)) { console.error(`Cannot read ${DEFAULT_DATA_FILE}.`); return 1; }
    const wanted = args.ids ? args.ids.split(',').map(s => s.trim()).filter(Boolean) : collectVideoIds(data);
    const unavailable = readJson(unavailableFile, {});
    const have = id => fs.existsSync(path.join(dir, `${id}.json`));
    const todo = wanted.filter(id => args.force || (!have(id) && (args['retry-unavailable'] || !unavailable[id])));

    if (args.check) {
        const missing = wanted.filter(id => !have(id));
        console.log(`${wanted.length - missing.length} of ${wanted.length} videos have a transcript.`);
        missing.forEach(id => console.log(`  missing: ${id}${unavailable[id] ? '  (no captions found)' : ''}`));
        return missing.length ? 1 : 0;
    }

    if (!todo.length) { console.log('Nothing to fetch.'); writeIndex(dir); return 0; }

    const bin = args['yt-dlp'] || 'yt-dlp';
    if (!haveYtDlp(bin)) {
        console.error('yt-dlp was not found. It is free: https://github.com/yt-dlp/yt-dlp#installation (or `pip install yt-dlp`).');
        console.error('Without it you can still add transcripts made with Whisper (--import-whisper) or write marks by hand in data.json.');
        return 1;
    }

    const langs = args.langs ? args.langs.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_LANGS;
    let saved = 0;
    for (let i = 0; i < todo.length; i++) {
        const id = todo[i];
        process.stdout.write(`[${i + 1}/${todo.length}] ${id} ... `);
        let result;
        try { result = fetchCaptions(bin, id, langs); } catch (err) { console.log(`failed (${err.message})`); continue; }
        if (result.none) {
            unavailable[id] = { checked: today(), why: result.why || 'no captions in the wanted languages' };
            console.log('no captions');
        } else {
            writeTranscript(dir, makeTranscript({ videoId: id, lang: result.lang, source: 'captions', segments: result.segments, fetched: today() }));
            delete unavailable[id];
            saved++;
            console.log(`${result.segments.length} cues (${result.lang})`);
        }
        if (i < todo.length - 1) await sleep(PAUSE_MS);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(unavailableFile, JSON.stringify(unavailable, null, 2) + '\n');
    const { count } = writeIndex(dir);
    console.log(`Done: ${saved} new transcript(s); ${count} in the index; ${Object.keys(unavailable).length} video(s) without captions.`);
    return 0;
}

module.exports = {
    collectVideoIds, mergeShort, parseJson3, fromWhisper, pickSubtitleFile, buildIndex, makeTranscript, parseArgs, main,
    TRANSCRIPT_DIR, DEFAULT_LANGS,
};

if (require.main === module) {
    main().then(code => process.exit(code), err => { console.error(err); process.exit(1); });
}
