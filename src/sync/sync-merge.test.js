const M = require('./sync-merge');
const { loadSettings } = require('../core/settings');

beforeEach(() => localStorage.clear());

describe('defaults', () => {
    test('DEFAULT_PREFS matches what settings.js gives a new reader', () => {
        const s = loadSettings();
        M.SYNCED_PREFS.forEach(k => expect(M.DEFAULT_PREFS[k]).toEqual(s[k]));
    });
});

describe('mergeDocs', () => {
    const doc = (read = {}, study = {}, prefs = {}) => ({ v: 1, read, study, prefs });
    const d = { kn: 'x' };

    test('ticks from two devices are unioned', () => {
        const m = M.mergeDocs(doc({ a: [1, 5] }), doc({ b: [1, 6] }));
        expect(Object.keys(m.read).sort()).toEqual(['a', 'b']);
    });
    test('a newer un-tick beats an older tick, and the other way round', () => {
        expect(M.mergeDocs(doc({ a: [1, 5] }), doc({ a: [0, 9] })).read.a).toEqual([0, 9]);
        expect(M.mergeDocs(doc({ a: [0, 3] }), doc({ a: [1, 9] })).read.a).toEqual([1, 9]);
    });
    test('a tick from before sync (time 0) never beats an explicit un-tick, but is kept otherwise', () => {
        expect(M.mergeDocs(doc({ a: [1, 0] }), doc({ a: [0, 2] })).read.a).toEqual([0, 2]);
        expect(M.mergeDocs(doc({ a: [1, 0] }), doc()).read.a).toEqual([1, 0]);
    });
    test('on an exact tie, read wins; study "again" wins', () => {
        expect(M.mergeDocs(doc({ a: [0, 4] }), doc({ a: [1, 4] })).read.a[0]).toBe(1);
        const m = M.mergeDocs(doc({}, { q: { status: 'got', desc: d, t: 4 } }), doc({}, { q: { status: 'again', desc: d, t: 4 } }));
        expect(m.study.q.status).toBe('again');
    });
    test('is symmetric', () => {
        const a = doc({ a: [1, 5], b: [0, 2] }, { q: { status: 'got', desc: d, t: 4 } }, { fontScale: [1.2, 3] });
        const b = doc({ a: [0, 5], c: [1, 1] }, { q: { status: 'again', desc: d, t: 4 } }, { fontScale: [1.4, 3] });
        expect(M.docsEqual(M.mergeDocs(a, b), M.mergeDocs(b, a))).toBe(true);
    });
    test('prefs: newer wins per setting', () => {
        const m = M.mergeDocs(doc({}, {}, { fontScale: [1.2, 3], qrs: [false, 9] }), doc({}, {}, { fontScale: [1.4, 5] }));
        expect(m.prefs.fontScale).toEqual([1.4, 5]);
        expect(m.prefs.qrs).toEqual([false, 9]);
    });
    test('garbage from Drive is dropped, not trusted', () => {
        expect(M.isValidPref('langs', ['kn', 'en', 'hi'])).toBe(false);   // the picker allows at most two
        const m = M.mergeDocs(null, { read: { a: [2, 1], b: 'x', c: [1, -3] }, study: { q: { status: 'hax', desc: d, t: 1 } }, prefs: { fontScale: [99, 1], evil: [1, 1], paperSize: ['a9', 1] } });
        expect(m).toEqual({ v: 1, read: {}, study: {}, prefs: {} });
        expect(M.mergeDocs('nope', undefined)).toEqual({ v: 1, read: {}, study: {}, prefs: {} });
    });
});

describe('localDoc / applyDocToLocal', () => {
    test('legacy data (no times) travels with time 0; un-ticks leave tombstones', () => {
        localStorage.setItem('readBlocks', JSON.stringify(['a', 'b']));
        const meta = M.stampRead(M.emptyMeta(), 'z', 7);
        const doc = M.localDoc(localStorage, meta);
        expect(doc.read).toEqual({ a: [1, 0], b: [1, 0], z: [0, 7] });
    });
    test('applying a merged doc stores ticks, skips unknown ids, reports what changed', () => {
        localStorage.setItem('readBlocks', JSON.stringify(['a']));
        const merged = { v: 1, read: { a: [1, 0], b: [1, 5], gone: [1, 5], c: [0, 6] }, study: {}, prefs: {} };
        const res = M.applyDocToLocal(merged, localStorage, M.emptyMeta(), { isKnownId: id => id !== 'gone' });
        expect(JSON.parse(localStorage.getItem('readBlocks')).sort()).toEqual(['a', 'b']);
        expect(res.changed).toEqual({ read: true, study: false });
        expect(res.meta.read).toEqual({ b: 5, c: 6 });
        expect(M.applyDocToLocal(merged, localStorage, res.meta, { isKnownId: id => id !== 'gone' }).changed.read).toBe(false);
    });
    test('an un-tick from another device removes the tick here', () => {
        localStorage.setItem('readBlocks', JSON.stringify(['a', 'b']));
        M.applyDocToLocal({ read: { a: [0, 9], b: [1, 0] } }, localStorage, M.emptyMeta());
        expect(JSON.parse(localStorage.getItem('readBlocks'))).toEqual(['b']);
    });
    test('study log keeps time order (newest last) and the 500 cap', () => {
        const study = {};
        for (let i = 0; i < 510; i++) study[`q${i}`] = { status: 'got', desc: { n: i }, t: i + 1 };
        M.applyDocToLocal({ study }, localStorage, M.emptyMeta());
        const keys = Object.keys(JSON.parse(localStorage.getItem('studyLog')));
        expect(keys).toHaveLength(500);
        expect(keys[0]).toBe('q10');
        expect(keys[499]).toBe('q509');
    });
});

describe('settings sync', () => {
    test('only explicitly changed settings travel, and device-only ones never do', () => {
        let meta = M.stampPrefs(M.emptyMeta(), ['fontScale', 'offline', 'aiEngine'], 5);
        expect(Object.keys(meta.prefs)).toEqual(['fontScale']);
        localStorage.setItem('settings', JSON.stringify({ fontScale: 1.3, offline: true }));
        expect(M.localDoc(localStorage, meta).prefs).toEqual({ fontScale: [1.3, 5] });
    });
    test('first sign-in adopts non-default settings made before sync, once', () => {
        localStorage.setItem('settings', JSON.stringify({ fontScale: 1.3, qrs: true }));
        const meta = M.adoptLegacyPrefs(M.emptyMeta(), loadSettings(), 50);
        expect(meta.prefs).toEqual({ fontScale: 50 });
        expect(M.adoptLegacyPrefs(meta, loadSettings(), 99).prefs).toEqual({ fontScale: 50 });
    });
    test('newerPrefs lists only what differs and is newer; applyPrefs writes it', () => {
        const doc = { prefs: { fontScale: [1.5, 9], qrs: [true, 9] } };
        const meta = M.stampPrefs(M.emptyMeta(), ['fontScale'], 3);
        expect(M.newerPrefs(doc, meta, loadSettings())).toEqual({ fontScale: 1.5 });
        const next = M.applyPrefs(doc, meta);
        expect(loadSettings().fontScale).toBe(1.5);
        expect(next.prefs.fontScale).toBe(9);
    });
});
