/**
 * @jest-environment node
 */
// Persistent storage request, the remembered model folder, and the two hooks the local engine gained for them
// (asking for persistence when the first use starts, and offering a saved folder just before a download).
// The browser's storage manager, IndexedDB and caches are replaced by small fakes here; the real IndexedDB
// round trip with a real folder handle is checked in a browser by test/e2e/core/model-folder-memory.test.js.

const { requestPersistentStorage, rememberFolder, recallFolder, forgetFolder, folderAccess } = require('./model-folder-memory');
const { createLocalEngine } = require('./local');
const { SCOPES, locations } = require('./model-files');

// A tiny IndexedDB: one database, one object store, values kept as they are (no structured clone needed here).
function fakeIdb() {
    const data = new Map();
    const later = fn => Promise.resolve().then(fn);
    return {
        data,
        open() {
            const req = {};
            later(() => {
                req.result = {
                    createObjectStore() {},
                    close() {},
                    transaction() {
                        const tx = {};
                        tx.objectStore = () => ({
                            put(value, key) { const r = {}; data.set(key, value); later(() => { tx.oncomplete && tx.oncomplete(); }); return r; },
                            get(key) { const r = {}; later(() => { r.result = data.get(key); tx.oncomplete && tx.oncomplete(); }); return r; },
                            delete(key) { const r = {}; data.delete(key); later(() => { tx.oncomplete && tx.oncomplete(); }); return r; },
                        });
                        return tx;
                    },
                };
                req.onupgradeneeded && req.onupgradeneeded();
                req.onsuccess && req.onsuccess();
            });
            return req;
        },
    };
}

describe('requestPersistentStorage', () => {
    test('asks the browser and reports the answer', async () => {
        const persist = jest.fn(async () => true);
        expect(await requestPersistentStorage({ persist, persisted: async () => false })).toBe('granted');
        expect(persist).toHaveBeenCalledTimes(1);
        expect(await requestPersistentStorage({ persist: async () => false, persisted: async () => false })).toBe('denied');
    });
    test('does not ask again when storage is already persistent', async () => {
        const persist = jest.fn(async () => true);
        expect(await requestPersistentStorage({ persist, persisted: async () => true })).toBe('granted');
        expect(persist).not.toHaveBeenCalled();
    });
    test('a browser without it, or one that throws, is not an error', async () => {
        expect(await requestPersistentStorage(null)).toBe('unsupported');
        expect(await requestPersistentStorage({})).toBe('unsupported');
        expect(await requestPersistentStorage({ persist: async () => { throw new Error('no'); } })).toBe('unsupported');
    });
});

describe('remembered folder', () => {
    test('remember, recall and forget', async () => {
        const idb = fakeIdb();
        expect(await recallFolder(idb)).toBeNull();
        const handle = { kind: 'directory', name: 'models' };
        expect(await rememberFolder(handle, idb)).toBe(true);
        expect(await recallFolder(idb)).toBe(handle);
        expect(await rememberFolder({ name: 'newer' }, idb)).toBe(true);
        expect((await recallFolder(idb)).name).toBe('newer');
        expect(await forgetFolder(idb)).toBe(true);
        expect(await recallFolder(idb)).toBeNull();
    });
    test('without IndexedDB nothing is remembered and nothing throws', async () => {
        expect(await rememberFolder({ name: 'x' }, null)).toBe(false);
        expect(await recallFolder(null)).toBeNull();
        expect(await forgetFolder(null)).toBe(true);
    });
    test('a failing database is not an error', async () => {
        const broken = { open() { const r = {}; Promise.resolve().then(() => { r.error = new Error('blocked'); r.onerror(); }); return r; } };
        expect(await rememberFolder({ name: 'x' }, broken)).toBe(false);
        expect(await recallFolder(broken)).toBeNull();
    });
});

describe('folderAccess', () => {
    test('already granted: no prompt', async () => {
        const requestPermission = jest.fn();
        expect(await folderAccess({ queryPermission: async () => 'granted', requestPermission })).toBe('granted');
        expect(requestPermission).not.toHaveBeenCalled();
    });
    test('needs a click: reports "prompt" without asking, then asks only when told to', async () => {
        const requestPermission = jest.fn(async () => 'granted');
        const handle = { queryPermission: async () => 'prompt', requestPermission };
        expect(await folderAccess(handle)).toBe('prompt');
        expect(requestPermission).not.toHaveBeenCalled();
        expect(await folderAccess(handle, { request: true })).toBe('granted');
        expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' });
    });
    test('refused or failing is "denied"', async () => {
        expect(await folderAccess({ queryPermission: async () => 'prompt', requestPermission: async () => 'denied' }, { request: true })).toBe('denied');
        expect(await folderAccess({ queryPermission: async () => { throw new Error('gone'); } })).toBe('denied');
    });
});

describe('local engine: persistence and the saved-folder offer', () => {
    const MODEL = 'Test-Model';
    const record = { model_id: MODEL, model: `https://huggingface.co/mlc-ai/${MODEL}`, model_lib: 'https://example.test/lib.wasm' };
    const base = locations(record).modelUrl;
    const fakeEngine = { chat: { completions: { create: async () => (async function* () {})() } }, interruptGenerate() {} };
    const makeLib = () => ({ prebuiltAppConfig: { model_list: [record] }, CreateMLCEngine: jest.fn(async () => fakeEngine) });

    function newCaches() {
        const stores = new Map();
        const c = {
            async open(name) {
                if (!stores.has(name)) stores.set(name, new Map());
                const s = stores.get(name);
                return { async match(url) { const t = s.get(typeof url === 'string' ? url : url.url); return t === undefined ? undefined : new Response(t); }, async put(r, res) { s.set(r.url, await res.text()); } };
            },
            // A complete download of the test model: its config, its file list and the one weight file in the list.
            async fill() {
                const put = async (scope, url, body) => (await c.open(SCOPES[scope])).put(new Request(url), new Response(body));
                await put('config', base + 'mlc-chat-config.json', '{}');
                await put('model', base + 'ndarray-cache.json', JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 1 }] }));
                await put('model', base + 'params_shard_0.bin', 'x');
            },
        };
        return c;
    }

    test('asks for persistent storage when the first use starts, and does not wait for the answer', async () => {
        const lib = makeLib();
        let release;
        const persist = jest.fn(() => new Promise(r => { release = r; }));   // a prompt nobody has answered yet
        const engine = createLocalEngine({ loadLibrary: async () => lib, modelId: MODEL, persist, cacheStorage: null });
        await engine.prepare();                                              // finishes although persist() is still pending
        expect(persist).toHaveBeenCalledTimes(1);
        expect(lib.CreateMLCEngine).toHaveBeenCalledTimes(1);
        release(true);
    });

    test('a persist() that throws changes nothing', async () => {
        const lib = makeLib();
        const engine = createLocalEngine({ loadLibrary: async () => lib, modelId: MODEL, persist: () => { throw new Error('x'); }, cacheStorage: null });
        await engine.prepare();
        expect(lib.CreateMLCEngine).toHaveBeenCalledTimes(1);
    });

    test('offers the saved folder before downloading, with both builds of the chosen size', async () => {
        const lib = makeLib();
        const order = [];
        lib.CreateMLCEngine = jest.fn(async () => { order.push('download'); return fakeEngine; });
        const beforeDownload = jest.fn(async () => { order.push('offer'); });
        const engine = createLocalEngine({ loadLibrary: async () => lib, modelId: MODEL, compatModelId: 'Test-Model-f32', persist: async () => 'granted', cacheStorage: newCaches() });
        await engine.prepare(undefined, { beforeDownload });
        expect(beforeDownload).toHaveBeenCalledWith({ modelIds: [MODEL, 'Test-Model-f32'] });
        expect(order).toEqual(['offer', 'download']);
    });

    test('does not offer anything when the model is already in the browser', async () => {
        const caches = newCaches();
        await caches.fill();
        const beforeDownload = jest.fn();
        const engine = createLocalEngine({ loadLibrary: async () => makeLib(), modelId: MODEL, persist: async () => 'granted', cacheStorage: caches });
        await engine.prepare(undefined, { beforeDownload });
        expect(beforeDownload).not.toHaveBeenCalled();
    });

    test('if the offer fails, the download still goes ahead', async () => {
        const lib = makeLib();
        const engine = createLocalEngine({ loadLibrary: async () => lib, modelId: MODEL, persist: async () => 'granted', cacheStorage: newCaches() });
        await engine.prepare(undefined, { beforeDownload: async () => { throw new Error('folder gone'); } });
        expect(lib.CreateMLCEngine).toHaveBeenCalledTimes(1);
    });

    test('a model the library does not list is never offered', async () => {
        const beforeDownload = jest.fn();
        const lib = { prebuiltAppConfig: { model_list: [] }, CreateMLCEngine: jest.fn(async () => fakeEngine) };
        const engine = createLocalEngine({ loadLibrary: async () => lib, modelId: MODEL, persist: async () => 'granted', cacheStorage: newCaches() });
        await engine.prepare(undefined, { beforeDownload });
        expect(beforeDownload).not.toHaveBeenCalled();
        expect(lib.CreateMLCEngine).toHaveBeenCalledTimes(1);
    });
});
