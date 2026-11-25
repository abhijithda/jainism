// sync/sync-engine.js — Decides when to sync and runs one sync: sign in → read the Drive copy → merge with this
// device → store what changed here → upload if the Drive copy is behind. localStorage stays the source of truth, so
// the book works exactly as before when signed out, offline, or if Google is unreachable; a failed sync just retries.
//
// Status values (what the UI shows): 'signed-out' | 'connecting' | 'syncing' | 'synced' | 'offline' | 'needs-signin' | 'error'.
// Two devices syncing at the same moment can overwrite each other's upload, but each keeps its own data and merges
// again on its next sync, so nothing is lost for good.

import {
    SYNCED_PREFS, loadMeta, saveMeta, stampRead, stampStudy, stampPrefs, adoptLegacyPrefs,
    localDoc, mergeDocs, docsEqual, newerPrefs, applyDocToLocal, applyPrefs,
} from './sync-merge.js';
import { loadSettings } from '../core/settings.js';

export const SYNC_STATE_KEY = 'syncState';   // { account: {name, email}, lastSyncAt }
export const DEBOUNCE_MS = 4000;
export const RESUME_AFTER_MS = 60 * 1000;

export function createSyncEngine({ storage, auth, drive, isKnownId, onApplied, onStatus, now = Date.now, win = window, doc = document, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let state = loadState();
    let status = state.account ? 'needs-signin' : 'signed-out';
    let message = '';
    let pending = {};          // newer display settings found on Drive, { key: value }
    let lastMerged = null;     // the last merged document, kept for "apply settings"
    let running = null, rerun = false, timer = null, applying = false, installed = false;
    let reconnectArmed = false, reconnectTried = false;

    function loadState() {
        try {
            const s = JSON.parse(storage.getItem(SYNC_STATE_KEY));
            if (s && typeof s === 'object' && s.account && typeof s.account === 'object') return { account: s.account, lastSyncAt: Number(s.lastSyncAt) || 0 };
        } catch (_) { /* unreadable: signed out */ }
        return { account: null, lastSyncAt: 0 };
    }
    function saveState() {
        try {
            if (state.account) storage.setItem(SYNC_STATE_KEY, JSON.stringify(state));
            else storage.removeItem(SYNC_STATE_KEY);
        } catch (_) { /* ignore */ }
    }
    function setStatus(s, msg = '') { status = s; message = msg; if (onStatus) onStatus(snapshot()); }
    const snapshot = () => ({ status, message, account: state.account, lastSyncAt: state.lastSyncAt, pendingPrefs: { ...pending } });
    const online = () => win.navigator.onLine !== false;

    // Browsers block Google's quiet re-sign-in popup when nobody has clicked yet (every page load), but allow it
    // during a click or key press. So after a quiet failure, the reader's first tap or key press tries once more:
    // if they already approved this site it closes by itself and sync resumes without the Reconnect button.
    // Tried once per page load, so a failing browser never gets a popup on every click.
    function armReconnect() {
        if (reconnectArmed || reconnectTried || !state.account) return;
        reconnectArmed = true;
        const go = () => {
            reconnectArmed = false; reconnectTried = true;
            ['pointerdown', 'keydown'].forEach(ev => doc.removeEventListener(ev, go, true));
            if (status === 'needs-signin') syncNow();
        };
        ['pointerdown', 'keydown'].forEach(ev => doc.addEventListener(ev, go, true));
    }

    async function once() {
        if (!online()) return setStatus('offline');
        setStatus('syncing');
        let token;
        try { token = await auth.getToken({ interactive: false }); }
        catch (_) { setStatus('needs-signin'); armReconnect(); return; }
        try {
            let meta = loadMeta(storage);
            const fileId = await drive.findFile(token);
            const remote = fileId ? await drive.readFile(token, fileId) : null;
            const merged = mergeDocs(localDoc(storage, meta), remote);

            lastMerged = merged;
            applying = true;
            let res;
            try { res = applyDocToLocal(merged, storage, meta, { isKnownId }); } finally { applying = false; }
            meta = res.meta;
            saveMeta(meta, storage);
            pending = newerPrefs(merged, meta, loadSettings());

            if (!docsEqual(merged, remote)) await drive.writeFile(token, fileId, merged);
            state.lastSyncAt = now();
            saveState();
            setStatus('synced');
            if ((res.changed.read || res.changed.study) && onApplied) onApplied(res.changed);
        } catch (e) {
            if (e && e.status === 401) { auth.forget(); setStatus('needs-signin'); armReconnect(); }
            else if (!online()) setStatus('offline');
            else setStatus('error', e && e.status === 403 ? 'Google Drive refused access. Sign in again and allow saving to Drive.' : 'Could not reach Google Drive. Will try again.');
        }
    }

    function syncNow() {
        if (!state.account) return Promise.resolve();
        clearTimer(timer); timer = null;
        if (running) { rerun = true; return running; }
        running = (async () => { do { rerun = false; await once(); } while (rerun); })().finally(() => { running = null; });
        return running;
    }

    function schedule() {
        if (!state.account) return;
        clearTimer(timer);
        timer = setTimer(() => { timer = null; return syncNow(); }, DEBOUNCE_MS);
    }

    // Remember when each tick / answer / setting last changed. Recorded even when signed out, so a later sign-in merges correctly.
    function track() {
        if (installed) return;
        installed = true;
        const stamp = fn => { saveMeta(fn(loadMeta(storage)), storage); schedule(); };
        doc.addEventListener('pooja:block-read', e => { const id = e.detail && e.detail.blockId; if (id) stamp(m => stampRead(m, id, now())); });
        doc.addEventListener('pooja:study-logged', e => { const id = e.detail && e.detail.id; if (id) stamp(m => stampStudy(m, id, now())); });
        doc.addEventListener('pooja:settings-saved', e => {
            if (applying) return;
            const keys = ((e.detail && e.detail.keys) || []).filter(k => SYNCED_PREFS.includes(k));
            if (keys.length) stamp(m => stampPrefs(m, keys, now()));
        });
        doc.addEventListener('visibilitychange', () => {
            if (!state.account) return;
            if (doc.visibilityState === 'hidden') { if (timer) syncNow(); }                       // push what is waiting before the tab goes away
            else if (now() - state.lastSyncAt > RESUME_AFTER_MS) syncNow();                        // pick up what another device did
        });
        win.addEventListener('online', () => { syncNow(); });
    }

    return {
        snapshot,
        isSignedIn: () => !!state.account,

        /** Start tracking changes and, if this device was signed in before, sync quietly. */
        start() {
            track();
            if (state.account) { auth.setHint(state.account.email); syncNow(); }
        },

        /** From a click. */
        async signIn() {
            setStatus('connecting');
            let token;
            try { token = await auth.getToken({ interactive: true }); }
            catch (e) {
                setStatus('signed-out', e && e.code === 'scope_denied' ? e.message : e && /popup|closed|access_denied/.test(e.code || '') ? '' : (e && e.message) || 'Sign-in did not complete');
                return false;
            }
            const who = await drive.whoAmI(token);
            state = { account: who || { name: '', email: '' }, lastSyncAt: 0 };
            auth.setHint(state.account.email);
            saveState();
            saveMeta(adoptLegacyPrefs(loadMeta(storage), loadSettings(), now()), storage);
            await syncNow();
            return true;
        },

        /** From a click (reconnect after the quiet token ran out). */
        async reconnect() {
            if (!state.account) return this.signIn();
            setStatus('connecting');
            try { await auth.getToken({ interactive: true }); } catch (_) { return setStatus('needs-signin'); }
            return syncNow();
        },

        syncNow,

        /** Apply the display settings found on Drive (the reader agreed); the caller reloads the page. */
        applyPendingPrefs() {
            if (!lastMerged) return;
            applying = true;
            try { saveMeta(applyPrefs(lastMerged, loadMeta(storage)), storage); } finally { applying = false; }
            pending = {};
            setStatus(status, message);
        },

        /**
         * Sign out of sync on this device; the reading history stays on the device.
         * With deleteCloud, the copy in the reader's Drive is removed first (and sign-out is cancelled if that fails).
         */
        async signOut({ deleteCloud = false } = {}) {
            if (deleteCloud) {
                try {
                    const token = await auth.getToken({ interactive: true });
                    const id = await drive.findFile(token);
                    if (id) await drive.deleteFile(token, id);
                } catch (_) {
                    setStatus('error', 'Could not delete the copy in Google Drive, so you are still signed in.');
                    return false;
                }
            }
            clearTimer(timer); timer = null;
            auth.revoke();
            state = { account: null, lastSyncAt: 0 };
            pending = {};
            saveState();
            setStatus('signed-out');
            return true;
        },
    };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { SYNC_STATE_KEY, DEBOUNCE_MS, RESUME_AFTER_MS, createSyncEngine });
