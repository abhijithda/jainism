// ai/video-nav.js — Finds the moment in a linked video that a question is about.
//
// The book cites videos as evidence. This module turns "where in that video?"
// into a search, so the assistant can offer a "Watch" button that opens the
// video modal at the right second.
//
// Three kinds of evidence, best first:
//   mark        a moment the author noted by hand in data.json
//               (`videos[].marks: [{ t: "12:34", label: "…" }]`). Most reliable.
//   transcript  a ~30 s window of the video's own transcript, from
//               assets/transcripts/<videoId>.json (made by scripts/fetch-transcripts.js
//               from YouTube captions or Whisper). Useful, but only as accurate as the captions.
//   owner       no better evidence: the video is attached to a block of the book, so
//               "the video that goes with this passage" (from its start, or from the
//               ?t= in its link).
//
// Nothing here calls a model, and nothing from a model decides a timestamp: the
// seconds come from the author's marks or the transcript, and the matching
// words are shown to the reader under the button so they can check. That keeps
// the assistant's rule (never show unchecked model output) intact.
//
// Ranking reuses retrieval.js (same tokenizer, same Kannada trigrams and
// transliteration folding, same BM25), so a spelling that finds a passage finds a video.

import { tokenize, search } from './retrieval.js';
import { buildBlockIndex, formatIdForDisplay } from '../core/blocks.js';
import { LANG_CODES } from '../core/langs.js';
import { extractYouTubeId } from '../core/media.js';
import { isVideoId, parseClock, parseStartSeconds } from '../core/video-time.js';

const TAG_WEIGHT = 3;
const WINDOW_SECONDS = 30;
const WINDOW_CHARS = 500;
const LEAD_IN_SECONDS = 2;          // start a little early so the first word isn't cut off
const SNIPPET_CHARS = 220;
const OWNED_BOOST = 1.5;            // the video is attached to a passage the answer shows
const OWNED_ONLY_SCORE = 0.1;       // ...but nothing in it matched the words: still offered, last
const KIND_WEIGHT = { mark: 1.3, transcript: 1, owner: 0.8 };
const RELATIVE_FLOOR = 0.3;         // a match must score at least this share of the best one to be offered

// ── Reading what's in data.json ──────────────────────────────────────────

/**
 * Every distinct video in the book, with the blocks it is attached to and any
 * hand-written marks. A video can be attached to more than one block.
 * @param {Array} data  parsed data.json
 * @returns {Map<string, {videoId: string, owners: Object[], marks: {t: number, label: string}[]}>}
 */
export function collectVideos(data) {
    const videos = new Map();
    // Display labels (A-3.1) are worked out by buildBlockIndex; without it every label would read "?".
    buildBlockIndex(data || []);
    for (const item of data || []) {
        for (const block of item.blocks || []) {
            for (const v of block.videos || []) {
                const videoId = isVideoId(v?.youtubeId) ? v.youtubeId : extractYouTubeId(v?.url);
                if (!videoId) continue;
                if (!videos.has(videoId)) videos.set(videoId, { videoId, owners: [], marks: [] });
                const entry = videos.get(videoId);
                const text = {};
                for (const lang of LANG_CODES) {
                    const lines = (block.content?.[lang] || []).filter(l => String(l).trim() !== '');
                    if (lines.length) text[lang] = lines.join(' ');
                }
                entry.owners.push({
                    blockId: block.id,
                    label: formatIdForDisplay(block),
                    itemId: item.id,
                    tags: block.tags || [],
                    text,
                    start: parseStartSeconds(v.url),
                });
                for (const mark of v.marks || []) {
                    const t = parseClock(mark?.t);
                    const label = String(mark?.label ?? '').trim();
                    if (t != null && label) entry.marks.push({ t, label });
                }
            }
        }
    }
    return videos;
}

// ── Transcripts ──────────────────────────────────────────────────────────

/** Cues in any of the shapes a file may use -> sorted [{ s, t }] (or []). A cue may be `[seconds, "text"]`, `{ s, t }` or `{ start, text }`. */
function cuesFrom(list) {
    if (!Array.isArray(list)) return [];
    const segments = [];
    for (const seg of list) {
        let s; let t;
        if (Array.isArray(seg)) [s, t] = seg;
        else if (seg && typeof seg === 'object') { s = seg.s ?? seg.start; t = seg.t ?? seg.text; }
        s = parseClock(s);
        t = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
        if (s != null && t) segments.push({ s, t });
    }
    return segments.sort((a, b) => a.s - b.s);
}

/**
 * Accepts the shapes a transcript file may come in and returns one:
 * `{ lang, source, segments: [{ s, t }], alt: [{ lang, source, segments }] }`, or null if there is nothing usable.
 * `segments` is the main track (the language that is spoken); `alt` holds extra tracks, machine translations of it
 * (`via: 'gemini'` for the ones made by scripts/translate-transcripts.js, empty for YouTube's), kept so a question in
 * another language has words to match.
 * @param {Object} raw
 */
export function normalizeTranscript(raw) {
    const segments = cuesFrom(Array.isArray(raw) ? raw : raw?.segments);
    if (!segments.length) return null;
    const alt = [];
    for (const track of Array.isArray(raw?.alt) ? raw.alt : []) {
        const cues = cuesFrom(track?.segments);
        if (cues.length) alt.push({ lang: typeof track.lang === 'string' ? track.lang : '', source: typeof track.source === 'string' ? track.source : 'translated', via: typeof track.via === 'string' ? track.via : '', segments: cues });
    }
    return {
        lang: typeof raw?.lang === 'string' ? raw.lang : '',
        source: typeof raw?.source === 'string' ? raw.source : 'captions',
        segments,
        alt,
    };
}

/**
 * Groups consecutive segments into windows of about half a minute, each sharing
 * one segment with the next so a phrase that straddles the cut is whole in one of them.
 * @param {{s: number, t: string}[]} segments  sorted by s
 * @returns {{start: number, text: string}[]}
 */
export function windowSegments(segments, { maxSpan = WINDOW_SECONDS, maxChars = WINDOW_CHARS } = {}) {
    const out = [];
    let i = 0;
    while (i < segments.length) {
        let j = i;
        let chars = 0;
        while (j < segments.length) {
            const seg = segments[j];
            if (j > i && (seg.s - segments[i].s > maxSpan || chars + seg.t.length > maxChars)) break;
            chars += seg.t.length + 1;
            j++;
        }
        out.push({ start: segments[i].s, text: segments.slice(i, j).map(x => x.t).join(' ') });
        if (j >= segments.length) break;
        i = Math.max(i + 1, j - 1);
    }
    return out;
}

/**
 * Loads the transcripts that exist. assets/transcripts/index.json lists the
 * available ids (so the page never asks for the many videos that have none); a
 * missing index, a missing file or a broken file just means "no transcript".
 * @returns {Promise<Object<string, ReturnType<typeof normalizeTranscript>>>}
 */
export async function loadTranscripts({ fetchFn = (typeof fetch === 'function' ? fetch : null), base = 'assets/transcripts/', concurrency = 4 } = {}) {
    if (!fetchFn) return {};
    let listing;
    try {
        const res = await fetchFn(`${base}index.json`);
        if (!res.ok) return {};
        listing = await res.json();
    } catch (_) {
        return {};
    }
    const ids = Object.keys(listing && typeof listing === 'object' ? listing : {}).filter(isVideoId);
    const out = {};
    let next = 0;
    const worker = async () => {
        while (next < ids.length) {
            const id = ids[next++];
            try {
                const res = await fetchFn(`${base}${id}.json`);
                if (!res.ok) continue;
                const transcript = normalizeTranscript(await res.json());
                if (transcript) out[id] = transcript;
            } catch (_) { /* this video simply has no transcript */ }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    return out;
}

// ── The index ────────────────────────────────────────────────────────────

/**
 * @param {{data: Array, transcripts?: Object}} args
 * @returns an index in the same shape retrieval.js ranks, plus `videos`.
 */
export function createVideoIndex({ data, transcripts = {} }) {
    const videos = collectVideos(data);
    const chunks = [];

    const add = (fields, text, tags = []) => {
        const tf = new Map();
        const bump = (term, n) => tf.set(term, (tf.get(term) || 0) + n);
        tokenize(text).forEach(term => bump(term, 1));
        tags.forEach(tag => tokenize(tag).forEach(term => bump(term, TAG_WEIGHT)));
        let length = 0;
        tf.forEach(n => { length += n; });
        if (length) chunks.push({ ...fields, tf, length });
    };

    let withTranscript = 0;
    for (const video of videos.values()) {
        const first = video.owners[0];
        for (const owner of video.owners) {
            add(
                { kind: 'owner', videoId: video.videoId, start: owner.start, blockId: owner.blockId, label: owner.label, snippet: '' },
                Object.values(owner.text).join(' '),
                owner.tags,
            );
        }
        for (const mark of video.marks) {
            // A mark's label counts like a tag: the author wrote it to say what is there.
            add({ kind: 'mark', videoId: video.videoId, start: mark.t, blockId: first.blockId, label: first.label, snippet: mark.label }, '', [mark.label]);
        }
        const transcript = transcripts[video.videoId] ? normalizeTranscript(transcripts[video.videoId]) : null;
        if (transcript) {
            withTranscript++;
            // The main track, then any translated ones: each is searched by its own words and its own times.
            const tracks = [{ source: transcript.source, via: '', segments: transcript.segments }, ...transcript.alt];
            for (const track of tracks) {
                for (const w of windowSegments(track.segments)) {
                    add({ kind: 'transcript', videoId: video.videoId, start: w.start, blockId: first.blockId, label: first.label, snippet: w.text, source: track.source, via: track.via }, w.text);
                }
            }
        }
    }

    const df = new Map();
    chunks.forEach(c => c.tf.forEach((_, term) => df.set(term, (df.get(term) || 0) + 1)));
    const avgLength = chunks.length ? chunks.reduce((s, c) => s + c.length, 0) / chunks.length : 0;
    return { chunks, df, avgLength, videos, stats: { videos: videos.size, withTranscript } };
}

// ── Asking ───────────────────────────────────────────────────────────────

function cut(text, n) {
    const t = String(text || '').trim();
    return t.length > n ? t.slice(0, n).trimEnd() + '\u2026' : t;
}

/**
 * The videos (and the moment in each) that best answer a question.
 *
 * @param {Object} vindex   from createVideoIndex()
 * @param {string} query    the reader's question
 * @param {{passages?: {id: string}[], k?: number, minScore?: number}} [opts]
 *   `passages`: the book passages the answer shows. A video attached to one of them is
 *   ranked higher, and is offered even if no word of the question matched inside it
 *   (it is the evidence video for what the reader is looking at).
 * @returns {{videoId: string, start: number, kind: 'mark'|'transcript'|'owner', snippet: string,
 *            source?: string, via?: string, label: string, blockId: string, score: number}[]}
 */
export function findMoments(vindex, query, { passages = [], k = 3, minScore = 0.5 } = {}) {
    if (!vindex || !vindex.chunks.length) return [];
    const wanted = new Set(passages.map(p => p.id));
    const ownedBy = id => vindex.videos.get(id)?.owners.find(o => wanted.has(o.blockId));

    // Per video: its best score, its best positioned chunk (a mark or a transcript window), and its owner chunk.
    const perVideo = new Map();
    for (const { chunk, score } of search(vindex, query, { k: 400 })) {
        if (score < minScore) continue;
        const weighted = score * KIND_WEIGHT[chunk.kind] * (ownedBy(chunk.videoId) ? OWNED_BOOST : 1);
        let entry = perVideo.get(chunk.videoId);
        if (!entry) { entry = { score: 0, moment: null, momentScore: 0, owner: null }; perVideo.set(chunk.videoId, entry); }
        entry.score = Math.max(entry.score, weighted);
        if (chunk.kind === 'owner') {
            if (!entry.owner || weighted > entry.owner.weighted) entry.owner = { chunk, weighted };
        } else if (weighted > entry.momentScore) {
            entry.moment = chunk;
            entry.momentScore = weighted;
        }
    }

    const results = [];
    for (const [videoId, entry] of perVideo) {
        const video = vindex.videos.get(videoId);
        const owner = ownedBy(videoId) || entry.owner?.chunk || video.owners[0];
        const label = owner.label;
        const blockId = owner.blockId;
        if (entry.moment) {
            const m = entry.moment;
            const lead = m.kind === 'transcript' ? LEAD_IN_SECONDS : 0;
            results.push({
                videoId, start: Math.max(0, m.start - lead), kind: m.kind, snippet: cut(m.snippet, SNIPPET_CHARS),
                source: m.source, via: m.via, label, blockId, score: entry.score,
            });
        } else {
            results.push({ videoId, start: owner.start || 0, kind: 'owner', snippet: '', label, blockId, score: entry.score });
        }
    }

    // A weak match next to a strong one is more likely a common word than the right video.
    const top = results.reduce((m, r) => Math.max(m, r.score), 0);
    for (let i = results.length - 1; i >= 0; i--) if (results[i].score < top * RELATIVE_FLOOR) results.splice(i, 1);

    // Videos attached to the passages being shown, even with no matching words: after the matches.
    for (const id of wanted) {
        for (const [videoId, video] of vindex.videos) {
            const owner = video.owners.find(o => o.blockId === id);
            if (!owner || results.some(r => r.videoId === videoId)) continue;
            results.push({ videoId, start: owner.start || 0, kind: 'owner', snippet: '', label: owner.label, blockId: owner.blockId, score: OWNED_ONLY_SCORE });
        }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, k);
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        collectVideos, normalizeTranscript, windowSegments, loadTranscripts, createVideoIndex, findMoments,
    });
}
