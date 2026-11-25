// sync/sync-merge.js — Pure logic for keeping reading history the same on every device.
//
// What is synced (and nothing else):
//   read ticks     localStorage `readBlocks`
//   study log      localStorage `studyLog`
//   reader prefs   the few display choices in `settings` (SYNCED_PREFS). Device-specific ones — offline copy, the AI
//                  engine and its addresses, the AI panel width — are deliberately left out.
//
// How two devices are reconciled: every item carries the time it was last changed, and the newer change wins, one
// item at a time ("last writer wins" per tick / per question / per setting). So reading on the phone and the laptop
// in the same week merges to both sets of ticks, and un-ticking on one device un-ticks it on the other.
// Un-ticks are kept as small "tombstones" ([0, time]) — without them an un-tick would just reappear from the other
// device. Times are stored beside the data in `syncMeta`, so the existing keys keep exactly their old format.
//
// Ticks and study answers that existed before sync was switched on have time 0: they always lose to any real change
// but are never lost, so a first sign-in merges everything (a union) instead of replacing anything.

import { getReadBlocks, saveReadBlocks } from '../core/read-tracking.js';
import { loadStudyLog, saveStudyLog } from '../study/study-log.js';
import { loadSettings, saveSettings, PAPER_SIZES, FONT_SCALE_MIN, FONT_SCALE_MAX } from '../core/settings.js';
import { KNOWN_LANGS, MAX_ACTIVE_LANGS } from '../core/langs.js';

export const SYNC_META_KEY = 'syncMeta';
export const DOC_VERSION = 1;
export const MAX_STUDY_ENTRIES = 500;   // same cap as study-log.js

export const SYNCED_PREFS = ['langs', 'videos', 'qrs', 'readTracking', 'studyCompanion', 'paperSize', 'fontScale'];

// What settings.js gives a reader who has never changed anything (a test keeps this in step with it).
export const DEFAULT_PREFS = {
    langs: KNOWN_LANGS.slice(0, 2).map(l => l.code),
    videos: true,
    qrs: true,
    readTracking: false,
    studyCompanion: false,
    paperSize: 'dynamic',
    fontScale: 1,
};

const STATUSES = ['got', 'again'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isTime = t => typeof t === 'number' && Number.isFinite(t) && t >= 0;

/** Is `value` something this setting may hold? (Remote data is never trusted.) */
export function isValidPref(key, value) {
    switch (key) {
        case 'langs':          return Array.isArray(value) && value.length > 0 && value.length <= MAX_ACTIVE_LANGS && value.every(c => KNOWN_LANGS.some(l => l.code === c));
        case 'videos': case 'qrs': case 'readTracking': case 'studyCompanion': return typeof value === 'boolean';
        case 'paperSize':      return PAPER_SIZES.includes(value);
        case 'fontScale':      return typeof value === 'number' && value >= FONT_SCALE_MIN && value <= FONT_SCALE_MAX;
        default:               return false;
    }
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Change times, kept in localStorage `syncMeta` ──────────────────────────

export function emptyMeta() { return { read: {}, study: {}, prefs: {}, adopted: false }; }

export function loadMeta(storage) {
    let saved;
    try { saved = JSON.parse(storage.getItem(SYNC_META_KEY)); } catch (_) { /* unreadable: start fresh */ }
    const meta = emptyMeta();
    if (!isObj(saved)) return meta;
    for (const part of ['read', 'study', 'prefs']) {
        if (isObj(saved[part])) for (const [k, t] of Object.entries(saved[part])) if (isTime(t) && t > 0) meta[part][k] = t;
    }
    meta.adopted = saved.adopted === true;
    return meta;
}

export function saveMeta(meta, storage) {
    try { storage.setItem(SYNC_META_KEY, JSON.stringify(meta)); } catch (_) { /* full or blocked: sync still works, just with older times */ }
}

export const stampRead  = (meta, id, t)   => ({ ...meta, read:  { ...meta.read,  [id]: t } });
export const stampStudy = (meta, id, t)   => ({ ...meta, study: { ...meta.study, [id]: t } });
export function stampPrefs(meta, keys, t) {
    const prefs = { ...meta.prefs };
    keys.filter(k => SYNCED_PREFS.includes(k)).forEach(k => { prefs[k] = t; });
    return { ...meta, prefs };
}

/**
 * Called once, the first time a device signs in: display choices the reader made before sync existed (no time yet)
 * get "now", so they travel to the other devices. Anything still at its default is left alone.
 */
export function adoptLegacyPrefs(meta, settings, t) {
    if (meta.adopted) return meta;
    const prefs = { ...meta.prefs };
    SYNCED_PREFS.forEach(k => { if (!prefs[k] && !sameValue(settings[k], DEFAULT_PREFS[k])) prefs[k] = t; });
    return { ...meta, prefs, adopted: true };
}

// ── The synced document ────────────────────────────────────────────────────
//   { v: 1,
//     read:  { <blockId>: [1 | 0, time] },
//     study: { <id>: { status, desc, t } },
//     prefs: { <key>: [value, time] } }

export function emptyDoc() { return { v: DOC_VERSION, read: {}, study: {}, prefs: {} }; }

/** Cleans anything — including a hand-edited or newer-version file from Drive — into a safe document. */
export function normalizeDoc(raw) {
    const doc = emptyDoc();
    if (!isObj(raw)) return doc;
    if (isObj(raw.read)) {
        for (const [id, e] of Object.entries(raw.read)) {
            if (Array.isArray(e) && (e[0] === 0 || e[0] === 1) && isTime(e[1])) doc.read[id] = [e[0], e[1]];
        }
    }
    if (isObj(raw.study)) {
        for (const [id, e] of Object.entries(raw.study)) {
            if (isObj(e) && STATUSES.includes(e.status) && isObj(e.desc) && isTime(e.t)) doc.study[id] = { status: e.status, desc: e.desc, t: e.t };
        }
    }
    if (isObj(raw.prefs)) {
        for (const [k, e] of Object.entries(raw.prefs)) {
            if (SYNCED_PREFS.includes(k) && Array.isArray(e) && isTime(e[1]) && isValidPref(k, e[0])) doc.prefs[k] = [e[0], e[1]];
        }
    }
    return doc;
}

/** This device's state as a document. */
export function localDoc(storage, meta) {
    const doc = emptyDoc();
    const readSet = getReadBlocks(storage);
    for (const id of readSet) doc.read[id] = [1, meta.read[id] || 0];
    for (const [id, t] of Object.entries(meta.read)) if (!readSet.has(id)) doc.read[id] = [0, t];

    for (const [id, v] of Object.entries(loadStudyLog(storage))) doc.study[id] = { status: v.status, desc: v.desc, t: meta.study[id] || 0 };

    // Only settings with a real change time travel: a never-touched default must not beat another device's choice.
    const settings = loadSettings();
    SYNCED_PREFS.forEach(k => { if (meta.prefs[k] > 0) doc.prefs[k] = [settings[k], meta.prefs[k]]; });
    return doc;
}

/** Newer change wins; on an exact tie `prefer` decides. Pure and symmetric except for that tie. */
function pick(a, b, timeOf, prefer) {
    if (!a) return b;
    if (!b) return a;
    const ta = timeOf(a), tb = timeOf(b);
    if (ta !== tb) return ta > tb ? a : b;
    return prefer(a, b);
}

/** Merges two documents (either may be null/garbage). Deterministic: merge(a, b) equals merge(b, a). */
export function mergeDocs(a, b) {
    const A = normalizeDoc(a), B = normalizeDoc(b);
    const out = emptyDoc();
    // Tie on read: "read" wins (nobody loses a tick to a coin-flip).
    for (const id of new Set([...Object.keys(A.read), ...Object.keys(B.read)])) {
        out.read[id] = pick(A.read[id], B.read[id], e => e[1], (x, y) => (x[0] >= y[0] ? x : y));
    }
    // Tie on study: "review later" wins over "got it" — the safer way to be wrong.
    for (const id of new Set([...Object.keys(A.study), ...Object.keys(B.study)])) {
        out.study[id] = pick(A.study[id], B.study[id], e => e.t, (x, y) => (x.status === 'again' ? x : y.status === 'again' ? y : x));
    }
    // Tie on prefs: the smaller JSON wins, an arbitrary but order-independent rule.
    for (const k of new Set([...Object.keys(A.prefs), ...Object.keys(B.prefs)])) {
        out.prefs[k] = pick(A.prefs[k], B.prefs[k], e => e[1], (x, y) => (JSON.stringify(x[0]) <= JSON.stringify(y[0]) ? x : y));
    }
    return out;
}

function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
/** Same content, whatever the key order. Used to skip an upload when nothing changed. */
export const docsEqual = (a, b) => stable(normalizeDoc(a)) === stable(normalizeDoc(b));

/** Settings the remote has newer than this device, for the "apply settings" notice: { key: value }. */
export function newerPrefs(doc, meta, settings) {
    const out = {};
    for (const [k, [value, t]] of Object.entries(normalizeDoc(doc).prefs)) {
        if (t > (meta.prefs[k] || 0) && !sameValue(value, settings[k])) out[k] = value;
    }
    return out;
}

/**
 * Writes the merged document into localStorage — ticks and study log only. Display settings are applied separately
 * (applyPrefs), after the reader agrees, because changing them under someone mid-reading is jarring.
 *
 * @param {Object} doc       the merged document
 * @param {Storage} storage
 * @param {Object} meta      current change times
 * @param {{isKnownId?: (id:string)=>boolean}} [opts]  ids the book no longer has are neither shown nor counted (they stay in `doc`, for devices on a newer book)
 * @returns {{meta: Object, changed: {read: boolean, study: boolean}}}
 */
export function applyDocToLocal(doc, storage, meta, { isKnownId = () => true } = {}) {
    const d = normalizeDoc(doc);
    const next = { ...meta, read: {}, study: {} };

    // Ticks
    const before = getReadBlocks(storage);
    const after = new Set();
    for (const [id, [r, t]] of Object.entries(d.read)) {
        if (!isKnownId(id)) continue;
        if (r === 1) after.add(id);
        if (t > 0) next.read[id] = t;
    }
    const readChanged = before.size !== after.size || [...after].some(id => !before.has(id));
    if (readChanged) saveReadBlocks(after, storage);

    // Study log, oldest first so the newest survive the cap and stay "most recent" (study-log.js's order)
    const oldLog = loadStudyLog(storage);
    const oldOrder = new Map(Object.keys(oldLog).map((id, i) => [id, i]));
    const entries = Object.entries(d.study).sort(([ia, a], [ib, b]) =>
        a.t - b.t || (oldOrder.get(ia) ?? Infinity) - (oldOrder.get(ib) ?? Infinity) || (ia < ib ? -1 : 1));
    const log = {};
    for (const [id, e] of entries.slice(-MAX_STUDY_ENTRIES)) {
        log[id] = { status: e.status, desc: e.desc };
        if (e.t > 0) next.study[id] = e.t;
    }
    const studyChanged = stable(log) !== stable(oldLog);
    if (studyChanged) saveStudyLog(log, storage);

    return { meta: next, changed: { read: readChanged, study: studyChanged } };
}

/** Applies the newer display settings (see newerPrefs) and records their times. Returns the new meta. */
export function applyPrefs(doc, meta) {
    const next = { ...meta, prefs: { ...meta.prefs } };
    const settings = loadSettings();
    const update = {};
    for (const [k, [value, t]] of Object.entries(normalizeDoc(doc).prefs)) {
        if (t > (meta.prefs[k] || 0)) {
            if (!sameValue(value, settings[k])) update[k] = value;
            next.prefs[k] = t;
        }
    }
    if (Object.keys(update).length) saveSettings(update);
    return next;
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, {
        SYNC_META_KEY, DOC_VERSION, MAX_STUDY_ENTRIES, SYNCED_PREFS, DEFAULT_PREFS, isValidPref,
        emptyMeta, loadMeta, saveMeta, stampRead, stampStudy, stampPrefs, adoptLegacyPrefs,
        emptyDoc, normalizeDoc, localDoc, mergeDocs, docsEqual, newerPrefs, applyDocToLocal, applyPrefs,
    });
}
