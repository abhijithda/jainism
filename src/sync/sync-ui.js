// sync/sync-ui.js — The "Save progress" section, shown in Settings and on Home. Both copies are plain markup in
// index.html marked data-sync; this file fills them in and wires their buttons, so the two can never differ.

import { SYNCED_PREFS } from './sync-merge.js';

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Settings found on Drive that this page knows about (the Apply button and its note both go by this). */
export const pendingKeys = snap => Object.keys((snap && snap.pendingPrefs) || {}).filter(k => SYNCED_PREFS.includes(k));

/** What to say and which buttons to offer for an engine snapshot. Pure. */
export function describe(snap, now = Date.now()) {
    const who = snap.account && (snap.account.email || snap.account.name);
    const out = { text: '', actions: [], hint: !snap.account };   // the explanation is for people who have not signed in
    switch (snap.status) {
        case 'connecting':   out.text = 'Signing in…'; break;
        case 'syncing':      out.text = 'Syncing…'; break;
        case 'synced':
            out.text = `✓ Synced${who ? ` as ${who}` : ''} · ${snap.lastSyncAt ? formatAgo(snap.lastSyncAt, now) : 'just now'}`;
            out.actions = ['sync', 'signout', 'delete']; break;
        case 'offline':
            out.text = '📴 Offline — your progress is kept on this device and will sync when you are back online.';
            out.actions = snap.account ? ['signout'] : ['signin']; break;
        case 'needs-signin':
            out.text = 'Sync is paused. Reconnect to keep your progress up to date.';
            out.actions = ['reconnect', 'signout']; break;
        case 'error':
            out.text = `⚠️ ${snap.message || 'Could not sync.'}`;
            out.actions = ['sync', 'signout']; break;
        default:
            out.text = snap.message || 'Sign in with Google to keep your reading progress on all your devices.';
            out.actions = ['signin'];
    }
    if (pendingKeys(snap).length && snap.status === 'synced') out.actions.unshift('apply');
    return out;
}

const LABELS = {
    signin: 'Sign in with Google', reconnect: 'Reconnect', sync: 'Sync now', signout: 'Sign out',
    delete: 'Delete cloud copy', apply: 'Use settings from my other device',
};

/**
 * @param {Object} args
 * @param {Object} args.engine        from createSyncEngine
 * @param {Object} args.auth          from createAuth (preload on hover, so the popup is not blocked)
 * @param {(reload: boolean) => void} [args.afterSettings]  called after display settings were applied
 */
export function initSyncUi({ engine, auth, doc = document, win = typeof window !== 'undefined' ? window : globalThis, afterSettings = () => location.reload() }) {
    const sections = [...doc.querySelectorAll('[data-sync]')];
    if (!sections.length) return { render() {}, dispose() {} };

    function render(snap = engine.snapshot()) {
        const d = describe(snap);
        sections.forEach(sec => {
            sec.hidden = false;
            // The privacy link is added only once sign-in is actually offered (a page with no sign-in has no such link).
            sec.querySelectorAll('[data-sync-hint]').forEach(h => { h.hidden = !d.hint; });
            sec.querySelectorAll('[data-sync-privacy]').forEach(slot => {
                if (slot.firstChild) return;
                const a = doc.createElement('a');
                a.href = 'privacy.html'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Privacy'; a.title = 'Privacy policy';
                slot.appendChild(a);
            });
            const text = sec.querySelector('[data-sync-status]');
            if (text) text.textContent = d.text;
            sec.querySelectorAll('[data-sync-action]').forEach(btn => {
                const a = btn.dataset.syncAction;
                btn.hidden = !d.actions.includes(a);
                btn.disabled = snap.status === 'connecting' || snap.status === 'syncing';
                if (!btn.textContent) btn.textContent = LABELS[a];
            });
            const note = sec.querySelector('[data-sync-prefs-note]');
            if (note) {
                note.hidden = !(pendingKeys(snap).length && snap.status === 'synced');
            }
        });
    }

    // Open Google's script early when the reader is about to press Sign in (browsers allow the popup only soon after a click).
    const warm = e => { if (e.target.closest && e.target.closest('[data-sync-action="signin"],[data-sync-action="reconnect"]')) auth.preload(); };
    const WARM_EVENTS = ['pointerenter', 'focusin', 'touchstart'];
    WARM_EVENTS.forEach(ev => doc.addEventListener(ev, warm, { passive: true }));

    const onClick = async e => {
        const btn = e.target.closest && e.target.closest('[data-sync-action]');
        if (!btn) return;
        const a = btn.dataset.syncAction;
        if (a === 'signin') await engine.signIn();
        else if (a === 'reconnect') await engine.reconnect();
        else if (a === 'sync') await engine.syncNow();
        else if (a === 'signout') await engine.signOut();
        else if (a === 'delete') {
            // Without a working confirm() nothing is deleted: this action must always be an explicit yes.
            const ask = typeof win.confirm === 'function' ? win.confirm.bind(win) : () => false;
            if (ask('Delete the progress saved in your Google Drive and sign out? Your reading progress stays on this device.')) await engine.signOut({ deleteCloud: true });
        } else if (a === 'apply') { engine.applyPendingPrefs(); afterSettings(true); }
    };
    doc.addEventListener('click', onClick);

    // Keep "· 5 min ago" fresh without waiting for a status change.
    const timer = setInterval(() => { if (!doc.hidden) render(); }, 60 * 1000);
    render();
    return {
        render,
        dispose() {
            clearInterval(timer);
            doc.removeEventListener('click', onClick);
            WARM_EVENTS.forEach(ev => doc.removeEventListener(ev, warm));
        },
    };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { formatAgo, pendingKeys, describe, initSyncUi });
