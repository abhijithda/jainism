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

/** What to say and which buttons to offer for an engine snapshot. Pure. */
export function describe(snap, now = Date.now()) {
    const who = snap.account && (snap.account.email || snap.account.name);
    const out = { text: '', actions: [] };
    switch (snap.status) {
        case 'connecting':   out.text = 'Signing in…'; break;
        case 'syncing':      out.text = 'Syncing…'; break;
        case 'synced':
            out.text = `✓ Saved to your Google Drive${who ? ` (${who})` : ''} · ${snap.lastSyncAt ? formatAgo(snap.lastSyncAt, now) : 'just now'}`;
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
    if (Object.keys(snap.pendingPrefs || {}).length && snap.status === 'synced') out.actions.unshift('apply');
    return out;
}

const LABELS = {
    signin: 'Sign in with Google', reconnect: 'Reconnect', sync: 'Sync now', signout: 'Sign out',
    delete: 'Sign out and delete my cloud copy', apply: 'Use settings from my other device',
};

/**
 * @param {Object} args
 * @param {Object} args.engine        from createSyncEngine
 * @param {Object} args.auth          from createAuth (preload on hover, so the popup is not blocked)
 * @param {(reload: boolean) => void} [args.afterSettings]  called after display settings were applied
 */
export function initSyncUi({ engine, auth, doc = document, afterSettings = () => location.reload() }) {
    const sections = [...doc.querySelectorAll('[data-sync]')];
    if (!sections.length) return { render() {} };

    function render(snap = engine.snapshot()) {
        const d = describe(snap);
        sections.forEach(sec => {
            sec.hidden = false;
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
                const keys = Object.keys(snap.pendingPrefs || {}).filter(k => SYNCED_PREFS.includes(k));
                note.hidden = !(keys.length && snap.status === 'synced');
            }
        });
    }

    // Open Google's script early when the reader is about to press Sign in (browsers allow the popup only soon after a click).
    ['pointerenter', 'focusin', 'touchstart'].forEach(ev =>
        doc.addEventListener(ev, e => { if (e.target.closest && e.target.closest('[data-sync-action="signin"],[data-sync-action="reconnect"]')) auth.preload(); }, { passive: true }));

    doc.addEventListener('click', async e => {
        const btn = e.target.closest && e.target.closest('[data-sync-action]');
        if (!btn) return;
        const a = btn.dataset.syncAction;
        if (a === 'signin') await engine.signIn();
        else if (a === 'reconnect') await engine.reconnect();
        else if (a === 'sync') await engine.syncNow();
        else if (a === 'signout') await engine.signOut();
        else if (a === 'delete') {
            if (confirm('Delete the progress saved in your Google Drive and sign out? Your reading progress stays on this device.')) await engine.signOut({ deleteCloud: true });
        } else if (a === 'apply') { engine.applyPendingPrefs(); afterSettings(true); }
    });

    // Keep "· 5 min ago" fresh without waiting for a status change.
    setInterval(() => { if (!doc.hidden) render(); }, 60 * 1000);
    render();
    return { render };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { formatAgo, describe, initSyncUi });
