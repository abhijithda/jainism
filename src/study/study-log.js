// study/study-log.js — What the reader has done with study questions, kept on
// this device (localStorage). Only descriptors and a status are stored, never
// the book's text, so a log from an older version of the book still loads.
//
//   status 'got'    the reader said they knew it
//   status 'again'  "review later": offered again from the Study panel's review list

export const STUDY_LOG_KEY = 'studyLog';
const MAX_ENTRIES = 500;
const STATUSES = ['got', 'again'];

/** @returns {Object} id -> {status, desc} */
export function loadStudyLog(storage) {
    let saved;
    try { saved = JSON.parse(storage.getItem(STUDY_LOG_KEY)); } catch (_) { /* unreadable: start fresh */ }
    const log = {};
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, v] of Object.entries(saved)) {
            if (v && STATUSES.includes(v.status) && v.desc && typeof v.desc === 'object') log[id] = { status: v.status, desc: v.desc };
        }
    }
    return log;
}

export function saveStudyLog(log, storage) {
    // Keep the most recent entries if it ever grows large (insertion order is time order).
    const entries = Object.entries(log).slice(-MAX_ENTRIES);
    try { storage.setItem(STUDY_LOG_KEY, JSON.stringify(Object.fromEntries(entries))); } catch (_) { /* full or blocked */ }
}

/** Pure: returns a new log with `id` recorded (it moves to the end, as the most recent). */
export function recordResult(log, id, desc, status) {
    if (!STATUSES.includes(status)) return log;
    const next = { ...log };
    delete next[id];
    next[id] = { status, desc };
    return next;
}

export const reviewList = log => Object.entries(log).filter(([, v]) => v.status === 'again').map(([id, v]) => ({ id, desc: v.desc }));

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { STUDY_LOG_KEY, loadStudyLog, saveStudyLog, recordResult, reviewList });
}
