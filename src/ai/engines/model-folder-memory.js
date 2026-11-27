// ai/engines/model-folder-memory.js — Two small helpers for the on-device model's copy in a folder.
//
//  1. requestPersistentStorage(): asks the browser not to evict this site's data (the downloaded model
//     included) when the disk runs low. It does NOT stop the reader clearing the site's data by hand;
//     the folder copy (model-files.js) is for that.
//  2. rememberFolder() / recallFolder() / forgetFolder(): keeps the folder the reader saved to or loaded
//     from, as a folder handle in IndexedDB, so a later session can offer to load the model from it.
//     A handle survives, but the browser usually asks for read permission again in each new session, which
//     needs a click (folderAccess with request: true must run inside a click handler).
//
// The browser objects (storage manager, IndexedDB) are passed in, so the logic is testable.

const DB_NAME = 'pooja-model-folder';
const STORE = 'handles';
const KEY = 'folder';

/**
 * @returns {Promise<'granted'|'denied'|'unsupported'>}
 */
export async function requestPersistentStorage(storage = typeof navigator !== 'undefined' ? navigator.storage : null) {
    try {
        if (!storage || typeof storage.persist !== 'function') return 'unsupported';
        if (typeof storage.persisted === 'function' && await storage.persisted()) return 'granted';
        return (await storage.persist()) ? 'granted' : 'denied';
    } catch (_) { return 'unsupported'; }
}

const defaultIdb = () => (typeof indexedDB !== 'undefined' ? indexedDB : null);

function openDb(idb) {
    return new Promise((resolve, reject) => {
        const req = idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB is not available'));
    });
}

async function withStore(idb, mode, action) {
    if (!idb) return undefined;
    const db = await openDb(idb);
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const request = action(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(request ? request.result : undefined);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB aborted'));
        });
    } finally { try { db.close(); } catch (_) {} }
}

/** Remembers a folder handle (from showDirectoryPicker). Never throws: remembering is a convenience. */
export async function rememberFolder(handle, idb = defaultIdb()) {
    if (!idb) return false;
    try { await withStore(idb, 'readwrite', s => s.put(handle, KEY)); return true; } catch (_) { return false; }
}

/** The remembered folder handle, or null. */
export async function recallFolder(idb = defaultIdb()) {
    try { return (await withStore(idb, 'readonly', s => s.get(KEY))) || null; } catch (_) { return null; }
}

export async function forgetFolder(idb = defaultIdb()) {
    try { await withStore(idb, 'readwrite', s => s.delete(KEY)); return true; } catch (_) { return false; }
}

/**
 * Can the folder be read right now?
 * With request: false it only asks the browser (no dialog). With request: true it may show the browser's
 * permission prompt, which needs a click in progress, so call it straight from a click handler.
 * @returns {Promise<'granted'|'prompt'|'denied'>}
 */
export async function folderAccess(handle, { request = false } = {}) {
    try {
        if (typeof handle?.queryPermission !== 'function') return 'granted';   // old browser: reading will fail by itself if not allowed
        const opts = { mode: 'read' };
        if ((await handle.queryPermission(opts)) === 'granted') return 'granted';
        if (!request) return 'prompt';
        return (await handle.requestPermission(opts)) === 'granted' ? 'granted' : 'denied';
    } catch (_) { return 'denied'; }
}
