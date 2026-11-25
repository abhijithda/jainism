const { formatAgo, describe: describeSync, initSyncUi } = require('./sync-ui');

test('formatAgo', () => {
    const now = 10_000_000;
    expect(formatAgo(now - 5000, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60e3, now)).toBe('5 min ago');
    expect(formatAgo(now - 3 * 3600e3, now)).toBe('3 h ago');
    expect(formatAgo(now - 86400e3, now)).toBe('1 day ago');
    expect(formatAgo(now - 3 * 86400e3, now)).toBe('3 days ago');
});

describe('describe', () => {
    test('signed out offers only sign-in', () => {
        expect(describeSync({ status: 'signed-out' }).actions).toEqual(['signin']);
    });
    test('synced shows the account and offers sync/sign-out/delete', () => {
        const d = describeSync({ status: 'synced', account: { email: 'a@x.com' }, lastSyncAt: 1000 }, 1000);
        expect(d.text).toContain('a@x.com');
        expect(d.actions).toEqual(['sync', 'signout', 'delete']);
    });
    test('newer settings add the apply button', () => {
        expect(describeSync({ status: 'synced', pendingPrefs: { qrs: true } }).actions[0]).toBe('apply');
    });
    test('paused offers reconnect', () => {
        expect(describeSync({ status: 'needs-signin' }).actions).toContain('reconnect');
    });
});

test('the Apply button and its note agree: unknown keys alone offer nothing', () => {
    const { pendingKeys } = require('./sync-ui');
    expect(pendingKeys({ pendingPrefs: { mystery: 1 } })).toEqual([]);
    expect(describeSync({ status: 'synced', pendingPrefs: { mystery: 1 } }).actions).not.toContain('apply');
    expect(describeSync({ status: 'synced', pendingPrefs: { qrs: true } }).actions).toContain('apply');
    expect(describeSync({ status: 'error', pendingPrefs: { qrs: true } }).actions).not.toContain('apply');
});

test('delete cloud copy needs an explicit yes, and does nothing without a working confirm()', async () => {
    document.body.innerHTML = '<div data-sync><span data-sync-status></span><button data-sync-action="delete"></button></div>';
    const engine = { snapshot: () => ({ status: 'synced', account: {} }), signOut: jest.fn(async () => true) };
    const ui = initSyncUi({ engine, auth: { preload() {} }, win: { confirm: () => false } });
    document.querySelector('[data-sync-action="delete"]').click();
    expect(engine.signOut).not.toHaveBeenCalled();
    ui.dispose();
    const ui2 = initSyncUi({ engine, auth: { preload() {} }, win: {} });
    document.querySelector('[data-sync-action="delete"]').click();
    expect(engine.signOut).not.toHaveBeenCalled();
    ui2.dispose();
});

test('initSyncUi reveals the section, shows state, and routes clicks to the engine', async () => {
    document.body.innerHTML = `<div data-sync hidden><span data-sync-status></span>
        <button data-sync-action="signin" hidden></button><button data-sync-action="signout" hidden></button></div>
        <div data-sync hidden><span data-sync-status></span><span data-sync-privacy></span><button data-sync-action="signin" hidden></button></div>`;
    const engine = { snapshot: () => ({ status: 'signed-out' }), signIn: jest.fn(async () => true), signOut: jest.fn() };
    const ui = initSyncUi({ engine, auth: { preload: jest.fn() } });
    const secs = document.querySelectorAll('[data-sync]');
    expect([...secs].every(s => !s.hidden)).toBe(true);
    const btn = secs[0].querySelector('[data-sync-action="signin"]');
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe('Sign in with Google');
    const link = document.querySelector('[data-sync-privacy] a');
    expect(link.getAttribute('href')).toBe('privacy.html');
    expect(link.rel).toBe('noopener');
    expect(secs[0].querySelector('[data-sync-action="signout"]').hidden).toBe(true);
    btn.click();
    expect(engine.signIn).toHaveBeenCalled();
});
