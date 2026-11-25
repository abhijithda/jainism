const { createSyncEngine, SYNC_STATE_KEY, LAST_EMAIL_KEY } = require('./sync-engine');
const { loadMeta } = require('./sync-merge');

// An in-memory Drive and a fake sign-in, so the whole flow runs without Google.
function fakeDrive(initial = null) {
    const d = { file: initial, id: initial ? 'f1' : null, writes: 0, fail: null };
    return Object.assign(d, {
        findFile: async () => { if (d.fail) throw d.fail; return d.id; },
        readFile: async () => d.file,
        writeFile: async (t, id, doc) => { d.file = JSON.parse(JSON.stringify(doc)); d.id = id || 'f1'; d.writes++; return d.id; },
        deleteFile: async () => { d.file = null; d.id = null; },
        whoAmI: async () => ({ name: 'Asha', email: 'asha@example.com' }),
    });
}
const fakeAuth = (over = {}) => ({ getToken: jest.fn(async () => 'tok'), forget: jest.fn(), revoke: jest.fn(), setHint: jest.fn(), preload: jest.fn(), ...over });

function make({ drive = fakeDrive(), auth = fakeAuth(), now = () => 1000, extra = {} } = {}) {
    const statuses = [];
    const engine = createSyncEngine({ storage: localStorage, auth, drive, now, onStatus: s => statuses.push(s.status), setTimer: (fn) => { engine.fire = fn; return 1; }, clearTimer: () => {}, ...extra });
    return { engine, drive, auth, statuses };
}
const read = () => JSON.parse(localStorage.getItem('readBlocks') || '[]').sort();
const tick = (blockId, r = true) => { // what read-tick.js does: save, then announce
    const s = new Set(read()); r ? s.add(blockId) : s.delete(blockId);
    localStorage.setItem('readBlocks', JSON.stringify([...s]));
    document.dispatchEvent(new CustomEvent('pooja:block-read', { detail: { blockId, read: r } }));
};

beforeEach(() => { localStorage.clear(); });

test('first sign-in merges this device with Drive and uploads the union', async () => {
    localStorage.setItem('readBlocks', JSON.stringify(['a']));
    const { engine, drive } = make({ drive: fakeDrive({ v: 1, read: { b: [1, 500] }, study: {}, prefs: {} }) });
    expect(await engine.signIn()).toBe(true);
    expect(read()).toEqual(['a', 'b']);
    expect(Object.keys(drive.file.read).sort()).toEqual(['a', 'b']);
    expect(engine.snapshot()).toMatchObject({ status: 'synced', account: { email: 'asha@example.com' } });
    expect(JSON.parse(localStorage.getItem(SYNC_STATE_KEY)).account.email).toBe('asha@example.com');
});

test('no upload when Drive already has everything', async () => {
    const { engine, drive } = make({ drive: fakeDrive({ v: 1, read: { a: [1, 5] }, study: {}, prefs: {} }) });
    localStorage.setItem('readBlocks', JSON.stringify(['a']));
    localStorage.setItem('syncMeta', JSON.stringify({ read: { a: 5 }, adopted: true }));
    await engine.signIn();
    expect(drive.writes).toBe(0);
});

test('ticking and un-ticking are stamped, and an un-tick reaches Drive', async () => {
    let t = 1000;
    const { engine, drive } = make({ now: () => t });
    engine.start();
    await engine.signIn();
    tick('x');
    expect(loadMeta(localStorage).read.x).toBe(1000);
    await engine.syncNow();
    expect(drive.file.read.x).toEqual([1, 1000]);
    t = 2000;
    tick('x', false);
    await engine.syncNow();
    expect(drive.file.read.x).toEqual([0, 2000]);
});

test('a change is pushed after the debounce, not on every click', async () => {
    const { engine, drive } = make();
    engine.start();
    await engine.signIn();
    const before = drive.writes;
    tick('p'); tick('q');
    expect(drive.writes).toBe(before);
    await engine.fire();
    expect(drive.writes).toBe(before + 1);
});

test("another device's ticks appear here and onApplied hears about it", async () => {
    const onApplied = jest.fn();
    const { engine } = make({ drive: fakeDrive({ v: 1, read: { z: [1, 900] }, study: {}, prefs: {} }), extra: { onApplied } });
    await engine.signIn();
    expect(read()).toEqual(['z']);
    expect(onApplied).toHaveBeenCalledWith({ read: true, study: false });
});

test('ids the book does not have are kept on Drive but not stored here', async () => {
    const { engine, drive } = make({ drive: fakeDrive({ v: 1, read: { newer: [1, 900] }, study: {}, prefs: {} }), extra: { isKnownId: id => id !== 'newer' } });
    await engine.signIn();
    expect(read()).toEqual([]);
    expect(drive.file.read.newer).toEqual([1, 900]);
});

test('settings from another device are offered, not forced, and applied on request', async () => {
    const { engine } = make({ drive: fakeDrive({ v: 1, read: {}, study: {}, prefs: { fontScale: [1.4, 900] } }) });
    await engine.signIn();
    expect(engine.snapshot().pendingPrefs).toEqual({ fontScale: 1.4 });
    expect(JSON.parse(localStorage.getItem('settings') || '{}').fontScale).toBeUndefined();
    engine.applyPendingPrefs();
    expect(JSON.parse(localStorage.getItem('settings')).fontScale).toBe(1.4);
    expect(engine.snapshot().pendingPrefs).toEqual({});
    // applying must not count as a local change that would be stamped as newer
    expect(loadMeta(localStorage).prefs.fontScale).toBe(900);
});

test('a local setting change is stamped; device-only settings are not', async () => {
    const { engine } = make();
    engine.start();
    await engine.signIn();
    document.dispatchEvent(new CustomEvent('pooja:settings-saved', { detail: { keys: ['qrs', 'offline'] } }));
    expect(Object.keys(loadMeta(localStorage).prefs)).toEqual(['qrs']);
});

describe('failure modes keep the book working', () => {
    test('cancelling the Google popup leaves the reader signed out, with no error shown', async () => {
        const { engine } = make({ auth: fakeAuth({ getToken: async () => { const e = new Error('closed'); e.code = 'popup_closed'; throw e; } }) });
        expect(await engine.signIn()).toBe(false);
        expect(engine.snapshot()).toMatchObject({ status: 'signed-out', message: '' });
    });
    test('declining the Drive permission explains why', async () => {
        const { engine } = make({ auth: fakeAuth({ getToken: async () => { const e = new Error('Permission to save to Google Drive was not given'); e.code = 'scope_denied'; throw e; } }) });
        await engine.signIn();
        expect(engine.snapshot().message).toMatch(/Permission/);
    });
    test('a signed-in device whose quiet token expired asks to reconnect, and local data is untouched', async () => {
        localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ account: { email: 'a@x.com' }, lastSyncAt: 5 }));
        localStorage.setItem('readBlocks', JSON.stringify(['a']));
        const { engine } = make({ auth: fakeAuth({ getToken: async () => { throw new Error('interaction_required'); } }) });
        engine.start();
        await engine.syncNow();
        expect(engine.snapshot().status).toBe('needs-signin');
        expect(read()).toEqual(['a']);
    });
    test('after a quiet failure, the first tap tries once more and sync resumes; it never retries on every click', async () => {
        localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ account: { email: 'a@x.com' }, lastSyncAt: 5 }));
        let ok = false;
        const getToken = jest.fn(async () => { if (!ok) throw new Error('popup_failed_to_open'); return 'tok'; });
        const { engine } = make({ auth: fakeAuth({ getToken }) });
        engine.start();
        await engine.syncNow();
        expect(engine.snapshot().status).toBe('needs-signin');

        ok = true;                                           // the browser allows it now: we are inside a click
        document.dispatchEvent(new Event('pointerdown'));
        await engine.syncNow();                              // waits for the sync the tap started
        expect(engine.snapshot().status).toBe('synced');

        // a browser that keeps refusing is tried only once per page load
        const again = make({ auth: fakeAuth({ getToken: jest.fn(async () => { throw new Error('x'); }) }) });
        again.engine.start();
        await again.engine.syncNow();
        document.dispatchEvent(new Event('keydown'));
        await again.engine.syncNow();
        const calls = again.auth.getToken.mock.calls.length;
        document.dispatchEvent(new Event('keydown'));
        document.dispatchEvent(new Event('pointerdown'));
        await again.engine.syncNow();
        expect(again.auth.getToken.mock.calls.length).toBe(calls + 1);   // only the explicit syncNow above, no tap-triggered retries
    });
    test('401 from Drive means reconnect; other errors retry later', async () => {
        const drive = fakeDrive(); const { engine, auth } = make({ drive });
        await engine.signIn();
        drive.fail = Object.assign(new Error('x'), { status: 401 });
        await engine.syncNow();
        expect(engine.snapshot().status).toBe('needs-signin');
        expect(auth.forget).toHaveBeenCalled();
        drive.fail = Object.assign(new Error('x'), { status: 500 });
        await engine.syncNow();
        expect(engine.snapshot().status).toBe('error');
    });
    test('offline: nothing is attempted', async () => {
        const { engine, auth } = make({ extra: { win: { navigator: { onLine: false }, addEventListener() {} } } });
        await engine.signIn().catch(() => {});
        auth.getToken.mockClear();
        await engine.syncNow();
        expect(engine.snapshot().status).toBe('offline');
        expect(auth.getToken).not.toHaveBeenCalled();
    });
});

describe('remembering the account', () => {
    test('the address is kept after sign-out and preselects the next sign-in (and quiet reconnects)', async () => {
        const first = make();
        await first.engine.signIn();
        expect(localStorage.getItem(LAST_EMAIL_KEY)).toBe('asha@example.com');
        await first.engine.signOut();
        expect(localStorage.getItem(SYNC_STATE_KEY)).toBeNull();
        expect(localStorage.getItem(LAST_EMAIL_KEY)).toBe('asha@example.com');

        const again = make();
        again.engine.start();
        expect(again.auth.setHint).toHaveBeenCalledWith('asha@example.com');
        again.auth.setHint.mockClear();
        await again.engine.signIn();
        expect(again.auth.setHint.mock.calls[0][0]).toBe('asha@example.com');    // before the Google popup opens
    });
    test('nothing is remembered if the reader never signs in', async () => {
        const { engine } = make({ auth: fakeAuth({ getToken: async () => { const e = new Error('closed'); e.code = 'popup_closed'; throw e; } }) });
        await engine.signIn();
        expect(localStorage.getItem(LAST_EMAIL_KEY)).toBeNull();
    });
});

describe('sign out', () => {
    test('keeps the reading history on this device and revokes access', async () => {
        const { engine, auth } = make();
        await engine.signIn();
        tick('keep');
        await engine.signOut();
        expect(read()).toEqual(['keep']);
        expect(auth.revoke).toHaveBeenCalled();
        expect(localStorage.getItem(SYNC_STATE_KEY)).toBeNull();
        expect(engine.snapshot().status).toBe('signed-out');
    });
    test('can also delete the Drive copy; if that fails you stay signed in', async () => {
        const { engine, drive } = make();
        await engine.signIn();
        await engine.signOut({ deleteCloud: true });
        expect(drive.file).toBeNull();

        const bad = fakeDrive(); const m = make({ drive: bad });
        await m.engine.signIn();
        bad.deleteFile = async () => { throw new Error('x'); };
        bad.findFile = async () => 'f1';
        expect(await m.engine.signOut({ deleteCloud: true })).toBe(false);
        expect(m.engine.isSignedIn()).toBe(true);
    });
});
