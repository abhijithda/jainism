// sync/sync-ui.js — The "Sync" row, shown in Settings and on Home. index.html holds only an empty mount point
// (data-sync) in each place; this file builds the row into both, so the two can never differ.
//
//   [cloud] Sync                   [↻] [person]       the cloud's color and mark show the state (hover for details)
//        └ person → small menu: your Google account, Sign out, Delete synced data, Privacy policy
//
// Text is kept for what must be clear (Sign in, Reconnect, the menu); icons carry the frequent, obvious things.
// Every icon button has an accessible name; hover hints are a bonus on desktop, never the only explanation.

import { SYNCED_PREFS } from './sync-merge.js';
import { icon, cloudIcon, googleG } from './icons.js';

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

export const NAME_HINT = 'Keeps your reading progress, study answers and display settings the same on all your devices.';
export const SIGNED_OUT_HINT = 'Optional. Not signed in, so your progress and settings stay on this device only. Signing in saves them in a hidden folder of your own Google Drive.';

/**
 * What the row shows for an engine snapshot. Pure.
 * `hintText` is the status line shown under the row in every state (the email is not in it: the account menu shows that).
 * @returns {{icon: 'out'|'sync'|'ok'|'warn'|'off', tip: string, actions: string[], hint: boolean, hintText: string, email: string, applyNote: boolean}}
 */
export function describe(snap, now = Date.now()) {
    const email = (snap.account && snap.account.email) || '';
    const signedIn = !!snap.account;
    const out = { icon: 'out', tip: 'Sync is off', actions: [], hint: !signedIn, hintText: snap.message || SIGNED_OUT_HINT, email, applyNote: false };
    switch (snap.status) {
        case 'connecting': out.icon = 'sync'; out.tip = 'Signing in…'; break;
        case 'syncing':    out.icon = 'sync'; out.tip = 'Syncing…'; out.actions = ['account']; break;
        case 'synced':
            out.icon = 'ok';
            out.tip = `Synced ${snap.lastSyncAt ? formatAgo(snap.lastSyncAt, now) : 'just now'}`;
            out.actions = ['refresh', 'account'];
            break;
        case 'offline':
            out.icon = 'off';
            out.tip = 'Offline. Your progress syncs when you’re back online.';
            out.actions = signedIn ? ['account'] : ['signin'];
            break;
        case 'needs-signin':
            out.icon = 'warn';
            out.tip = 'Sync is paused. Reconnect to keep your progress up to date.';
            out.actions = ['reconnect', 'account'];
            break;
        case 'error':
            out.icon = 'warn';
            out.tip = snap.message || 'Could not sync.';
            out.actions = ['refresh', 'account'];
            break;
        default:           out.actions = ['signin'];
    }
    out.applyNote = pendingKeys(snap).length > 0 && snap.status === 'synced';
    // Signed out: the reason / the optional-feature line. Signed in: where sync stands (plus what it carries once synced).
    out.hint = true;
    if (signedIn) out.hintText = snap.status === 'synced' ? `${out.tip}. ${NAME_HINT}` : out.tip;
    return out;
}

const ACCOUNT_TIP = 'Account';
const CONFIRM_DELETE = 'Delete your synced data from Google Drive and sign out? Your reading progress stays on this device.';

function el(doc, tag, cls, attrs = {}, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    return e;
}

const privacyLink = (doc, text) => el(doc, 'a', 'sync-privacy', { href: 'privacy.html', target: '_blank', rel: 'noopener', title: 'Privacy policy' }, text);

/** Builds the row into one mount point and returns the parts render() fills in. */
function build(doc, mount) {
    const colon = mount.classList.contains('menu-section') ? ':' : '';
    mount.textContent = '';

    const row = el(doc, 'div', 'sync-row');
    const label = el(doc, 'span', 'sync-label');
    const state = el(doc, 'span', 'sync-state', { role: 'img', tabindex: '0' });
    label.append(state, el(doc, 'span', 'sync-name tl', { 'data-tip': NAME_HINT, tabindex: '0' }, `Sync${colon}`));

    const actions = el(doc, 'div', 'sync-actions');
    // Google's own button has a plain "Sign in" variant: with the G logo the word "Google" is redundant (the full name stays as the tooltip and accessible name).
    const signin = el(doc, 'button', 'sync-btn sync-btn--google', { type: 'button', 'data-sync-action': 'signin', 'data-tip': 'Sign in with Google', 'aria-label': 'Sign in with Google' });
    signin.append(googleG(doc), 'Sign in');
    const reconnect = el(doc, 'button', 'sync-btn sync-btn--primary', { type: 'button', 'data-sync-action': 'reconnect' }, 'Reconnect');
    const refresh = el(doc, 'button', 'sync-ib', { type: 'button', 'data-sync-action': 'refresh', 'data-tip': 'Sync now', 'aria-label': 'Sync now' });
    refresh.append(icon(doc, 'refresh'));
    const account = el(doc, 'button', 'sync-ib', { type: 'button', 'data-sync-action': 'account', 'data-tip': ACCOUNT_TIP, 'aria-label': ACCOUNT_TIP, 'aria-haspopup': 'true', 'aria-expanded': 'false' });
    account.append(icon(doc, 'user'));
    actions.append(signin, reconnect, refresh, account);
    row.append(label, actions);

    const menu = el(doc, 'div', 'sync-menu', { role: 'menu', hidden: '' });
    const who = el(doc, 'div', 'sync-who');
    const whoEmail = el(doc, 'span', 'sync-email');
    who.append(el(doc, 'span', 'sync-avatar', { 'aria-hidden': 'true' }), whoEmail);
    const item = (name, text, action, cls = '') => {
        const b = el(doc, 'button', `sync-mi ${cls}`.trim(), { type: 'button', role: 'menuitem', 'data-sync-action': action });
        b.append(icon(doc, name, 17), text);
        return b;
    };
    const privacy = el(doc, 'a', 'sync-mi', { href: 'privacy.html', target: '_blank', rel: 'noopener', role: 'menuitem' });
    privacy.append(icon(doc, 'lock', 17), 'Privacy policy');
    menu.append(who, el(doc, 'div', 'sync-sep'), item('logout', 'Sign out', 'signout'), item('trash', 'Delete synced data', 'delete', 'sync-mi--danger'), el(doc, 'div', 'sync-sep'), privacy);

    const hint = el(doc, 'p', 'sync-hint');
    const hintText = el(doc, 'span');
    hint.append(hintText, ' ', privacyLink(doc, 'Privacy'));

    const note = el(doc, 'p', 'sync-hint', { hidden: '' });
    note.append('Settings from your other device are available. ', el(doc, 'button', 'sync-link', { type: 'button', 'data-sync-action': 'apply' }, 'Use them'));

    mount.append(row, menu, hint, note);
    return { mount, state, buttons: { signin, reconnect, refresh, account }, menu, whoEmail, who, hint, hintText, note };
}

/**
 * @param {Object} args
 * @param {Object} args.engine        from createSyncEngine
 * @param {Object} args.auth          from createAuth (preload on hover, so the popup is not blocked)
 * @param {(applied: boolean) => void} [args.afterSettings]  called after display settings were applied
 */
export function initSyncUi({ engine, auth, doc = document, win = typeof window !== 'undefined' ? window : globalThis, afterSettings = () => location.reload() }) {
    const parts = [...doc.querySelectorAll('[data-sync]')].map(m => build(doc, m));
    if (!parts.length) return { render() {}, dispose() {} };

    const closeMenus = () => parts.forEach(p => { p.menu.hidden = true; p.buttons.account.setAttribute('aria-expanded', 'false'); });

    function render(snap = engine.snapshot()) {
        const d = describe(snap);
        const busy = snap.status === 'connecting' || snap.status === 'syncing';
        parts.forEach(p => {
            p.mount.hidden = false;

            p.state.textContent = '';
            p.state.className = `sync-state sync-state--${d.icon}`;
            p.state.append(cloudIcon(doc, d.icon));
            p.state.setAttribute('data-tip', d.tip);
            p.state.setAttribute('aria-label', d.tip);

            Object.entries(p.buttons).forEach(([name, btn]) => {
                btn.hidden = !d.actions.includes(name);
                btn.disabled = name === 'signin' && busy;
            });
            const who = d.email || '';
            p.buttons.account.setAttribute('data-tip', who || ACCOUNT_TIP);
            p.whoEmail.textContent = who || 'Google account';
            p.who.querySelector('.sync-avatar').textContent = (who || 'G').charAt(0).toUpperCase();
            if (!d.actions.includes('account')) closeMenus();

            p.hint.hidden = !d.hint;
            p.hint.className = `sync-hint sync-hint--${d.icon}`;
            p.hintText.textContent = d.hintText;
            p.note.hidden = !d.applyNote;
        });
    }

    // Open Google's script early when the reader is about to press Sign in (browsers allow the popup only soon after a click).
    const warm = e => { if (e.target.closest && e.target.closest('[data-sync-action="signin"],[data-sync-action="reconnect"]')) auth.preload(); };
    const WARM_EVENTS = ['pointerenter', 'focusin', 'touchstart'];
    WARM_EVENTS.forEach(ev => doc.addEventListener(ev, warm, { passive: true }));

    const onClick = async e => {
        const btn = e.target.closest && e.target.closest('[data-sync-action]');
        if (!btn) {
            // A click anywhere else closes an open account menu (links inside the menu, like Privacy, still work).
            if (!(e.target.closest && e.target.closest('.sync-menu'))) closeMenus();
            return;
        }
        const a = btn.dataset.syncAction;
        if (a === 'account') {
            const p = parts.find(x => x.buttons.account === btn.closest('button'));
            const open = p && p.menu.hidden;
            closeMenus();
            if (p && open) { p.menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
            return;
        }
        closeMenus();
        if (a === 'signin') await engine.signIn();
        else if (a === 'reconnect') await engine.reconnect();
        else if (a === 'refresh') await engine.syncNow();
        else if (a === 'signout') await engine.signOut();
        else if (a === 'delete') {
            // Without a working confirm() nothing is deleted: this action must always be an explicit yes.
            const ask = typeof win.confirm === 'function' ? win.confirm.bind(win) : () => false;
            if (ask(CONFIRM_DELETE)) await engine.signOut({ deleteCloud: true });
        } else if (a === 'apply') { engine.applyPendingPrefs(); afterSettings(true); }
    };
    doc.addEventListener('click', onClick);

    const onKey = e => {
        if (e.key !== 'Escape') return;
        const open = parts.find(p => !p.menu.hidden);
        if (open) { closeMenus(); open.buttons.account.focus(); }
    };
    doc.addEventListener('keydown', onKey);

    // Keep "Synced 5 min ago" fresh without waiting for a status change.
    const timer = setInterval(() => { if (!doc.hidden) render(); }, 60 * 1000);
    render();
    return {
        render,
        dispose() {
            clearInterval(timer);
            doc.removeEventListener('click', onClick);
            doc.removeEventListener('keydown', onKey);
            WARM_EVENTS.forEach(ev => doc.removeEventListener(ev, warm));
        },
    };
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { formatAgo, pendingKeys, describe, initSyncUi, NAME_HINT, SIGNED_OUT_HINT });
