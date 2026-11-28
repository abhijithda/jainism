const { formatAgo, describe: describeSync, pendingKeys, initSyncUi, NAME_HINT } = require('./sync-ui');

afterEach(() => { document.body.innerHTML = ''; });

test('formatAgo', () => {
    const now = 10_000_000;
    expect(formatAgo(now - 5000, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60e3, now)).toBe('5 min ago');
    expect(formatAgo(now - 3 * 3600e3, now)).toBe('3 h ago');
    expect(formatAgo(now - 86400e3, now)).toBe('1 day ago');
    expect(formatAgo(now - 3 * 86400e3, now)).toBe('3 days ago');
});

describe('describe: what the row shows in each state', () => {
    const acct = { email: 'a@x.com' };
    test('signed out: only Sign in, with the short explanation', () => {
        const d = describeSync({ status: 'signed-out' });
        expect(d.actions).toEqual(['signin']);
        expect(d.hint).toBe(true);
        expect(d.icon).toBe('out');
        expect(d.tip).toBe('Sync is off');
    });
    test('a sign-in problem replaces the explanation', () => {
        expect(describeSync({ status: 'signed-out', message: 'Permission to save to Google Drive was not given' }).hintText).toMatch(/Permission/);
    });
    test('synced: a tick with the time, a refresh button and the account button, and a status line without the email', () => {
        const d = describeSync({ status: 'synced', account: acct, lastSyncAt: 1000 }, 1000);
        expect(d).toMatchObject({ icon: 'ok', tip: 'Synced just now', actions: ['refresh', 'account'], hint: true, email: 'a@x.com' });
        expect(d.hintText).toMatch(/^Synced just now\. /);
        expect(d.hintText).not.toMatch(/a@x\.com/);
    });
    test('syncing: a spinner and just the account button', () => {
        expect(describeSync({ status: 'syncing', account: acct })).toMatchObject({ icon: 'sync', actions: ['account'] });
    });
    test('paused: a warning with Reconnect (text) and the account button', () => {
        expect(describeSync({ status: 'needs-signin', account: acct })).toMatchObject({ icon: 'warn', actions: ['reconnect', 'account'] });
    });
    test('offline: signed in keeps only the account button; signed out still offers Sign in', () => {
        expect(describeSync({ status: 'offline', account: acct })).toMatchObject({ icon: 'off', actions: ['account'] });
        expect(describeSync({ status: 'offline' }).actions).toEqual(['signin']);
    });
    test('error: a warning that carries the reason, plus refresh and the account button', () => {
        expect(describeSync({ status: 'error', account: acct, message: 'Could not reach Google Drive. Will try again.' }))
            .toMatchObject({ icon: 'warn', tip: 'Could not reach Google Drive. Will try again.', actions: ['refresh', 'account'] });
    });
    test('the apply-settings note shows only when synced and the keys are ones this page knows', () => {
        expect(describeSync({ status: 'synced', account: acct, pendingPrefs: { qrs: true } }).applyNote).toBe(true);
        expect(describeSync({ status: 'synced', account: acct, pendingPrefs: { mystery: 1 } }).applyNote).toBe(false);
        expect(describeSync({ status: 'error', account: acct, pendingPrefs: { qrs: true } }).applyNote).toBe(false);
        expect(pendingKeys({ pendingPrefs: { mystery: 1 } })).toEqual([]);
    });
});

function mount(snap, extra = {}) {
    document.body.innerHTML = '<div class="menu-section" data-sync hidden></div><div class="home-section" data-sync hidden></div>';
    const engine = { snapshot: () => snap, signIn: jest.fn(async () => true), reconnect: jest.fn(), syncNow: jest.fn(), signOut: jest.fn(async () => true), applyPendingPrefs: jest.fn(), ...extra };
    const ui = initSyncUi({ engine, auth: { preload: jest.fn() }, win: { confirm: () => true }, afterSettings: jest.fn() });
    return { engine, ui, menu: document.querySelectorAll('[data-sync]')[0], home: document.querySelectorAll('[data-sync]')[1] };
}
const act = (root, a) => root.querySelector(`[data-sync-action="${a}"]`);

describe('the built row', () => {
    test('both places are built the same way, revealed, and labelled for their context', () => {
        const { menu, home } = mount({ status: 'signed-out' });
        expect(menu.hidden).toBe(false);
        expect(home.hidden).toBe(false);
        expect(menu.querySelector('.sync-name').textContent).toBe('Sync:');   // Settings rows carry a colon
        expect(home.querySelector('.sync-name').textContent).toBe('Sync');
        expect(menu.querySelector('.sync-name').dataset.tip).toBe(NAME_HINT);
        expect(act(menu, 'signin').textContent).toBe('Sign in');
        expect(act(menu, 'signin').getAttribute('aria-label')).toBe('Sign in with Google');
        expect(act(menu, 'signin').dataset.tip).toBe('Sign in with Google');
        expect(act(menu, 'signin').querySelectorAll('path')).toHaveLength(4);       // the four-color G
    });
    test('signed out: Sign in and the explanation show; the other buttons do not', () => {
        const { home } = mount({ status: 'signed-out' });
        expect(act(home, 'signin').hidden).toBe(false);
        ['reconnect', 'refresh'].forEach(a => expect(act(home, a).hidden).toBe(true));
        expect(home.querySelector('.sync-account, [data-sync-action="account"]').hidden).toBe(true);
        expect(home.querySelector('.sync-hint').hidden).toBe(false);
        expect(home.querySelector('.sync-hint a').getAttribute('href')).toBe('privacy.html');
    });
    test('synced: tick with its hover hint, refresh and account buttons with accessible names, and a status line', () => {
        const { home } = mount({ status: 'synced', account: { email: 'a@x.com' }, lastSyncAt: Date.now() });
        const state = home.querySelector('.sync-state');
        expect(state.hidden).toBe(false);
        expect(state.getAttribute('aria-label')).toBe('Synced just now');
        expect(state.dataset.tip).toBe('Synced just now');
        expect(act(home, 'refresh').getAttribute('aria-label')).toBe('Sync now');
        expect(act(home, 'account').getAttribute('aria-label')).toBe('Account');
        expect(act(home, 'account').dataset.tip).toBe('a@x.com');        // hover on desktop
        expect(home.querySelector('.sync-hint').hidden).toBe(false);
        expect(home.querySelector('.sync-hint').className).toContain('sync-hint--ok');
        expect(home.querySelector('.sync-hint').textContent).toMatch(/^Synced just now\./);
        expect(act(home, 'signin').hidden).toBe(true);
    });
    test('the account menu opens on click with the address first, closes on a second click, outside click and Escape', () => {
        const { home } = mount({ status: 'synced', account: { email: 'a@x.com' }, lastSyncAt: Date.now() });
        const menu = home.querySelector('.sync-menu');
        expect(menu.hidden).toBe(true);
        act(home, 'account').click();
        expect(menu.hidden).toBe(false);
        expect(act(home, 'account').getAttribute('aria-expanded')).toBe('true');
        expect(menu.querySelector('.sync-email').textContent).toBe('a@x.com');
        expect([...menu.querySelectorAll('.sync-mi')].map(b => b.textContent)).toEqual(['Sign out', 'Delete synced data', 'Privacy policy']);
        expect(menu.querySelector('a.sync-mi').getAttribute('href')).toBe('privacy.html');
        act(home, 'account').click();
        expect(menu.hidden).toBe(true);
        act(home, 'account').click();
        document.body.click();
        expect(menu.hidden).toBe(true);
        act(home, 'account').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(menu.hidden).toBe(true);
    });
    test('the menu has no Sync now (the refresh button is the one place for it)', () => {
        const { home } = mount({ status: 'synced', account: { email: 'a@x.com' } });
        expect(home.querySelector('.sync-menu').textContent).not.toMatch(/Sync now/);
    });
    test('buttons reach the engine: sign in, reconnect, refresh, sign out', async () => {
        const a = mount({ status: 'signed-out' });
        act(a.home, 'signin').click();
        expect(a.engine.signIn).toHaveBeenCalled();
        const b = mount({ status: 'needs-signin', account: { email: 'a@x.com' } });
        act(b.home, 'reconnect').click();
        expect(b.engine.reconnect).toHaveBeenCalled();
        const c = mount({ status: 'synced', account: { email: 'a@x.com' } });
        act(c.home, 'refresh').click();
        expect(c.engine.syncNow).toHaveBeenCalled();
        act(c.home, 'account').click();
        act(c.home, 'signout').click();
        expect(c.engine.signOut).toHaveBeenCalledWith();
        expect(c.home.querySelector('.sync-menu').hidden).toBe(true);
    });
    test('Delete synced data needs an explicit yes, and does nothing without a working confirm()', () => {
        document.body.innerHTML = '<div data-sync hidden></div>';
        const engine = { snapshot: () => ({ status: 'synced', account: { email: 'a@x.com' } }), signOut: jest.fn(async () => true) };
        let answer = false;
        const ui = initSyncUi({ engine, auth: { preload() {} }, win: { confirm: () => answer } });
        act(document, 'delete').click();
        expect(engine.signOut).not.toHaveBeenCalled();
        answer = true;
        act(document, 'delete').click();
        expect(engine.signOut).toHaveBeenCalledWith({ deleteCloud: true });
        ui.dispose();
        const ui2 = initSyncUi({ engine, auth: { preload() {} }, win: {} });
        engine.signOut.mockClear();
        act(document, 'delete').click();
        expect(engine.signOut).not.toHaveBeenCalled();
        ui2.dispose();
    });
    test('the settings note offers "Use them" only when there is something to apply, and applying reloads', () => {
        const { home, engine } = mount({ status: 'synced', account: { email: 'a@x.com' }, pendingPrefs: { qrs: true } });
        const note = [...home.querySelectorAll('.sync-hint')][1];
        expect(note.hidden).toBe(false);
        act(home, 'apply').click();
        expect(engine.applyPendingPrefs).toHaveBeenCalled();
        const other = mount({ status: 'synced', account: { email: 'a@x.com' } });
        expect([...other.home.querySelectorAll('.sync-hint')][1].hidden).toBe(true);
    });
    test('no mount points: nothing happens', () => {
        document.body.innerHTML = '';
        const ui = initSyncUi({ engine: { snapshot: () => ({}) }, auth: {} });
        expect(() => { ui.render(); ui.dispose(); }).not.toThrow();
    });
});

describe('the status cloud', () => {
    const state = snap => { const { home } = mount(snap); return home.querySelector('.sync-state'); };
    test('it comes first in the label, is always shown, and each state has its own color class and mark', () => {
        const { home } = mount({ status: 'signed-out' });
        const label = home.querySelector('.sync-label');
        expect(label.firstElementChild.classList.contains('sync-state')).toBe(true);
        expect(label.lastElementChild.classList.contains('sync-name')).toBe(true);
        const cases = [
            [{ status: 'signed-out' }, 'out', 0],
            [{ status: 'syncing', account: { email: 'a@x.com' } }, 'sync', 2],
            [{ status: 'synced', account: { email: 'a@x.com' }, lastSyncAt: Date.now() }, 'ok', 1],
            [{ status: 'needs-signin', account: { email: 'a@x.com' } }, 'warn', 2],
            [{ status: 'offline', account: { email: 'a@x.com' } }, 'off', 1],
        ];
        cases.forEach(([snap, kind, marks]) => {
            const s = state(snap);
            expect(s.className).toBe(`sync-state sync-state--${kind}`);
            expect(s.querySelectorAll('svg > path')).toHaveLength(kind === 'sync' ? 1 : 1 + marks);   // the cloud, plus its mark (the arrows sit in groups)
        });
    });
    test('only the syncing cloud has arrows to turn, inside a group CSS can animate', () => {
        const syncing = state({ status: 'syncing', account: { email: 'a@x.com' } });
        expect(syncing.querySelectorAll('.sync-cloud-arrows path')).toHaveLength(2);
        expect(state({ status: 'synced', account: { email: 'a@x.com' } }).querySelector('.sync-cloud-arrows')).toBeNull();
        const css = require('fs').readFileSync(require('path').join(__dirname, 'sync.css'), 'utf8');
        expect(css).toMatch(/\.sync-cloud-arrows\s*\{[^}]*animation:\s*sync-spin/);
        expect(css).toMatch(/prefers-reduced-motion[^}]*\.sync-cloud-arrows\s*\{\s*animation:\s*none/);
    });
    test('the cloud carries the hover hint and an accessible name', () => {
        const s = state({ status: 'synced', account: { email: 'a@x.com' }, lastSyncAt: Date.now() });
        expect(s.dataset.tip).toBe('Synced just now');
        expect(s.getAttribute('aria-label')).toBe('Synced just now');
        expect(s.getAttribute('role')).toBe('img');
    });
});
