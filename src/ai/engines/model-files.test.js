/**
 * @jest-environment node
 */
// Saving the browser's cached on-device model to a folder and loading it back. The browser's Cache API and a
// picked folder are replaced by in-memory fakes; the real thing (real Cache API, real folder handle) is checked
// in a browser by test/e2e/core/model-files.test.js.

const {
    SCOPES, MANIFEST_NAME, locations, belongsToModel, cachedState, saveModelsToFolder, loadModelsFromFolder, downloadModelToFolder, NoSavedCopyError, isModelCached, listFolderModels, MODEL_HOST,
    folderSource, fileListSource, ModelFolderError, webllmVersion,
} = require('./model-files');
const { LOCAL_TIERS } = require('../config');

// ── fakes ────────────────────────────────────────────────────────────────
function fakeCaches() {
    const stores = new Map();
    const open = async name => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {
            async match(req) { const e = store.get(typeof req === 'string' ? req : req.url); return e ? new Response(e.bytes, { headers: e.headers }) : undefined; },
            async put(req, res) { store.set(req.url, { bytes: new Uint8Array(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) }); },
            async keys() { return [...store.keys()].map(u => new Request(u)); },
        };
    };
    return { open, stores };
}

function fakeDir() {
    const files = new Map();      // 'a/b' -> Uint8Array
    const make = prefix => ({
        async getDirectoryHandle(name, { create } = {}) {
            if (!create && ![...files.keys()].some(k => k.startsWith(`${prefix}${name}/`))) throw new DOMException('nf', 'NotFoundError');
            return make(`${prefix}${name}/`);
        },
        async getFileHandle(name, { create } = {}) {
            const key = `${prefix}${name}`;
            if (!create && !files.has(key)) throw new DOMException('nf', 'NotFoundError');
            return {
                // Like the real FileSystemWritableFileStream: a WritableStream that also has write() and close().
                async createWritable() {
                    const chunks = [];
                    const stream = new WritableStream({
                        write(c) { chunks.push(typeof c === 'string' ? new TextEncoder().encode(c) : new Uint8Array(c)); },
                        close() { files.set(key, Buffer.concat(chunks)); },
                    });
                    stream.write = async c => { const w = stream.getWriter(); await w.write(c); w.releaseLock(); };
                    stream.close = async () => { const w = stream.getWriter(); await w.close(); };
                    return stream;
                },
                async getFile() { return new File([files.get(key)], name); },
            };
        },
    });
    return Object.assign(make(''), { files });
}

const MODEL_ID = LOCAL_TIERS.small.model;
const record = {
    model_id: MODEL_ID,
    model: `https://huggingface.co/mlc-ai/${MODEL_ID}`,
    model_lib: 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm',
};
const base = locations(record).modelUrl;
const recordFor = id => (id === MODEL_ID ? record : null);
const bytes = (...n) => new Uint8Array(n);

async function seed(caches, { shards = true, wasm = true, extra = true } = {}) {
    const put = async (scope, url, body) => (await caches.open(SCOPES[scope])).put(new Request(url), new Response(body));
    await put('config', base + 'mlc-chat-config.json', JSON.stringify({ a: 1 }));
    await put('model', base + 'ndarray-cache.json', JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 5 }, { dataPath: 'params_shard_1.bin', nbytes: 3 }] }));
    if (shards) {
        await put('model', base + 'params_shard_0.bin', bytes(1, 2, 3, 4, 5));
        await put('model', base + 'params_shard_1.bin', bytes(6, 7, 8));
    }
    await put('model', base + 'tokenizer.json', '{"t":1}');
    if (wasm) await put('wasm', record.model_lib, bytes(0, 97, 115, 109));
    if (extra) await put('model', 'https://huggingface.co/mlc-ai/Some-Other-Model/resolve/main/params_shard_0.bin', bytes(9));
}

const saveAll = (caches, dir) => saveModelsToFolder({ models: [{ modelId: MODEL_ID, record }], dir, caches });
const raw = async (caches, scope, url) => { const r = await (await caches.open(SCOPES[scope])).match(url); return r ? [...new Uint8Array(await r.arrayBuffer())] : null; };

// ── tests ────────────────────────────────────────────────────────────────
describe('addresses', () => {
    test('follow WebLLM\u2019s own rule for a model\u2019s base address', () => {
        expect(base).toBe(`https://huggingface.co/mlc-ai/${MODEL_ID}/resolve/main/`);
        expect(locations({ model: base, model_lib: 'x' }).modelUrl).toBe(base);
        expect(locations(record).configUrl).toBe(base + 'mlc-chat-config.json');
        expect(locations(record).ndarrayUrl).toBe(base + 'ndarray-cache.json');
    });

    test('only this model\u2019s own files belong to it', () => {
        expect(belongsToModel('model', base + 'params_shard_3.bin', record)).toBe(true);
        expect(belongsToModel('config', base + 'mlc-chat-config.json', record)).toBe(true);
        expect(belongsToModel('wasm', record.model_lib, record)).toBe(true);
        expect(belongsToModel('model', 'https://huggingface.co/mlc-ai/Other/resolve/main/x.bin', record)).toBe(false);
        expect(belongsToModel('model', 'https://evil.test/' + MODEL_ID + '/resolve/main/x.bin', record)).toBe(false);
        expect(belongsToModel('wasm', 'https://evil.test/a.wasm', record)).toBe(false);
        expect(belongsToModel('somewhere', base + 'x', record)).toBe(false);
    });

    test('the WebLLM version is read from the pinned address', () => {
        expect(webllmVersion('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm')).toBe('0.2.79');
        expect(webllmVersion('nothing')).toBe('');
    });
});

describe('cachedState', () => {
    test('complete only when the config, the file list and every weight file are cached', async () => {
        const c = fakeCaches();
        expect(await cachedState(record, c)).toEqual({ complete: false, reason: 'not downloaded' });
        await seed(c, { shards: false });
        expect(await cachedState(record, c)).toEqual({ complete: false, reason: 'only partly downloaded' });
        const full = fakeCaches();
        await seed(full);
        expect(await cachedState(record, full)).toEqual({ complete: true, reason: '' });
    });
});

describe('saving to a folder', () => {
    test('writes this model\u2019s files and a manifest, and leaves other models\u2019 files out', async () => {
        const c = fakeCaches(), dir = fakeDir();
        await seed(c);
        const r = await saveAll(c, dir);
        expect(r.saved).toEqual([MODEL_ID]);
        expect(r.bytes).toBeGreaterThan(8);
        const names = [...dir.files.keys()];
        expect(names).toContain(`${MODEL_ID}-model/params_shard_0.bin`);
        expect(names).toContain(`${MODEL_ID}-config/mlc-chat-config.json`);
        expect(names).toContain(`${MODEL_ID}-wasm/Qwen2-1.5B-Instruct-q4f16_1-ctx4k_cs1k-webgpu.wasm`);
        expect(names).toContain(MANIFEST_NAME);
        expect(names.some(n => n.includes('Some-Other-Model'))).toBe(false);
        expect([...dir.files.get(`${MODEL_ID}-model/params_shard_0.bin`)]).toEqual([1, 2, 3, 4, 5]);
        const manifest = JSON.parse(Buffer.from(dir.files.get(MANIFEST_NAME)).toString());
        expect(manifest.format).toBe(1);
        expect(manifest.models[0].modelId).toBe(MODEL_ID);
        expect(manifest.models[0].entries.every(e => e.url.startsWith('https://'))).toBe(true);
    });

    test('a model that is not fully downloaded is skipped with the reason, and nothing is written for it', async () => {
        const c = fakeCaches(), dir = fakeDir();
        await seed(c, { shards: false });
        const r = await saveAll(c, dir);
        expect(r.saved).toEqual([]);
        expect(r.skipped).toEqual([{ modelId: MODEL_ID, reason: 'only partly downloaded' }]);
        expect(dir.files.size).toBe(0);                       // not even a manifest
    });

    test('works without the compiled-code file (it is small and downloads on its own)', async () => {
        const c = fakeCaches(), dir = fakeDir();
        await seed(c, { wasm: false });
        expect((await saveAll(c, dir)).saved).toEqual([MODEL_ID]);
    });

    test('stops when cancelled, leaving no manifest', async () => {
        const c = fakeCaches(), dir = fakeDir();
        await seed(c);
        const ctl = new AbortController();
        ctl.abort();
        await expect(saveModelsToFolder({ models: [{ modelId: MODEL_ID, record }], dir, caches: c, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(dir.files.has(MANIFEST_NAME)).toBe(false);
    });

    test('reports each file as it goes', async () => {
        const c = fakeCaches(), dir = fakeDir(), seen = [];
        await seed(c);
        await saveModelsToFolder({ models: [{ modelId: MODEL_ID, record }], dir, caches: c, onProgress: p => seen.push(p.file) });
        expect(seen).toEqual(expect.arrayContaining(['params_shard_0.bin', 'params_shard_1.bin', 'ndarray-cache.json']));
    });
});

describe('loading from a folder', () => {
    async function saved() {
        const c = fakeCaches(), dir = fakeDir();
        await seed(c);
        await saveAll(c, dir);
        return dir;
    }
    const load = (dir, caches) => loadModelsFromFolder({ source: folderSource(dir), recordFor, caches });

    test('round trip: an emptied cache is filled again, byte for byte, and counts as fully downloaded', async () => {
        const dir = await saved();
        const fresh = fakeCaches();
        const r = await load(dir, fresh);
        expect(r.restored).toEqual([MODEL_ID]);
        expect(r.warnings).toEqual([]);
        expect(await raw(fresh, 'model', base + 'params_shard_0.bin')).toEqual([1, 2, 3, 4, 5]);
        expect(await raw(fresh, 'model', base + 'params_shard_1.bin')).toEqual([6, 7, 8]);
        expect(await raw(fresh, 'wasm', record.model_lib)).toEqual([0, 97, 115, 109]);
        expect((await (await (await fresh.open(SCOPES.config)).match(base + 'mlc-chat-config.json')).json())).toEqual({ a: 1 });
        expect(await cachedState(record, fresh)).toEqual({ complete: true, reason: '' });
        expect(await raw(fresh, 'model', 'https://huggingface.co/mlc-ai/Some-Other-Model/resolve/main/params_shard_0.bin')).toBeNull();
    });

    test('modelIds: only the chosen models are put back, and a folder without them is refused', async () => {
        const dir = await saved();
        const fresh = fakeCaches();
        const r = await loadModelsFromFolder({ source: folderSource(dir), recordFor, caches: fresh, modelIds: [MODEL_ID, 'Other-Model'] });
        expect(r.restored).toEqual([MODEL_ID]);
        expect(await cachedState(record, fresh)).toEqual({ complete: true, reason: '' });
        const none = fakeCaches();
        await expect(loadModelsFromFolder({ source: folderSource(dir), recordFor, caches: none, modelIds: ['Other-Model'] }))
            .rejects.toThrow(/no saved copy of the size you chose/);
        expect(none.stores.size).toBe(0);
    });

    test('loading twice is harmless', async () => {
        const dir = await saved(), fresh = fakeCaches();
        await load(dir, fresh);
        await expect(load(dir, fresh)).resolves.toMatchObject({ restored: [MODEL_ID] });
    });

    const refuses = async (mutate, message) => {
        const dir = await saved();
        await mutate(dir);
        const fresh = fakeCaches();
        await expect(load(dir, fresh)).rejects.toThrow(message);
        await expect(load(dir, fresh)).rejects.toBeInstanceOf(ModelFolderError);
        expect(fresh.stores.size).toBe(0);                     // nothing was put in the cache
    };
    const editManifest = fn => dir => { const m = JSON.parse(Buffer.from(dir.files.get(MANIFEST_NAME)).toString()); fn(m); dir.files.set(MANIFEST_NAME, Buffer.from(JSON.stringify(m))); };

    test('refuses a folder with no manifest', async () => {
        await refuses(dir => dir.files.delete(MANIFEST_NAME), /doesn.t hold a saved model/);
    });
    test('refuses an unreadable or foreign manifest', async () => {
        await refuses(dir => dir.files.set(MANIFEST_NAME, Buffer.from('not json')), /couldn.t be read/);
        await refuses(editManifest(m => { m.format = 99; }), /couldn.t be read/);
    });
    test('refuses an entry whose address is not this model\u2019s (a hand-edited folder can\u2019t plant other files in the cache)', async () => {
        await refuses(editManifest(m => { m.models[0].entries[0].url = 'https://evil.test/x.bin'; }), /doesn.t belong to the model/);
    });
    test('refuses file names that try to leave the folder', async () => {
        await refuses(editManifest(m => { m.models[0].entries[0].file = '../../x'; }), /doesn.t belong to the model/);
        await refuses(editManifest(m => { m.models[0].entries[0].folder = '..'; }), /doesn.t belong to the model/);
    });
    test('refuses a missing file', async () => {
        await refuses(dir => dir.files.delete(`${MODEL_ID}-model/params_shard_1.bin`), /missing params_shard_1.bin/);
    });
    test('refuses a file whose size changed since it was saved', async () => {
        await refuses(dir => dir.files.set(`${MODEL_ID}-model/params_shard_0.bin`, Buffer.from([1, 2])), /not the size it was saved at/);
    });
    test('refuses a weight file the model\u2019s own list says is a different size, even if the manifest agrees with it', async () => {
        await refuses(async dir => {
            dir.files.set(`${MODEL_ID}-model/params_shard_0.bin`, Buffer.from([1, 2]));
            editManifest(m => { m.models[0].entries.find(e => e.file === 'params_shard_0.bin').bytes = 2; })(dir);
        }, /not the size the model expects/);
    });
    test('refuses a model whose weight files are not all in the folder', async () => {
        await refuses(editManifest(m => { m.models[0].entries = m.models[0].entries.filter(e => e.file !== 'params_shard_1.bin'); }), /missing a weight file/);
    });
    test('refuses when the model\u2019s configuration is missing', async () => {
        await refuses(editManifest(m => { m.models[0].entries = m.models[0].entries.filter(e => e.scope !== 'config'); }), /incomplete/);
    });
    test('skips a model this site doesn\u2019t offer, and refuses if that leaves nothing', async () => {
        await refuses(editManifest(m => { m.models[0].modelId = 'Some-Other-Model'; }), /no model this site can use/);
    });

    test('a different WebLLM version is only a warning', async () => {
        const dir = await saved();
        editManifest(m => { m.webllm = '0.0.1'; })(dir);
        const r = await load(dir, fakeCaches());
        expect(r.restored).toEqual([MODEL_ID]);
        expect(r.warnings.join(' ')).toMatch(/0\.0\.1/);
    });

    test('reads a folder picked with a file input (a FileList) the same way', async () => {
        const dir = await saved();
        const list = [...dir.files.entries()].map(([path, data]) => {
            const f = new File([data], path.split('/').pop());
            Object.defineProperty(f, 'webkitRelativePath', { value: `picked/${path}` });
            return f;
        });
        const fresh = fakeCaches();
        const r = await loadModelsFromFolder({ source: fileListSource(list), recordFor, caches: fresh });
        expect(r.restored).toEqual([MODEL_ID]);
        expect(await cachedState(record, fresh)).toEqual({ complete: true, reason: '' });
    });
});

describe('downloading one model straight into a folder', () => {
    const files = {
        [base + 'mlc-chat-config.json']: JSON.stringify({ tokenizer_files: ['tokenizer.json', 'tokenizer.model'] }),
        [base + 'ndarray-cache.json']: JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 5 }, { dataPath: 'params_shard_1.bin', nbytes: 3 }] }),
        [base + 'params_shard_0.bin']: bytes(1, 2, 3, 4, 5),
        [base + 'params_shard_1.bin']: bytes(6, 7, 8),
        [base + 'tokenizer.json']: '{"t":1}',
        [record.model_lib]: bytes(0, 97, 115, 109),
    };                                                               // tokenizer.model is missing on the server (404)
    const makeFetch = (overrides = {}) => jest.fn(async url => {
        const body = (url in overrides ? overrides[url] : files[url]);
        return body === undefined ? new Response('nope', { status: 404 }) : body === 'FAIL' ? new Response('x', { status: 500 }) : new Response(body);
    });
    const run = (dir, fetchFn, extra = {}) => downloadModelToFolder({ modelId: MODEL_ID, record, dir, fetchFn, ...extra });

    test('writes the same files and manifest as a save, and the result loads into an empty cache', async () => {
        const dir = fakeDir(), fetchFn = makeFetch();
        const r = await run(dir, fetchFn);
        expect(r.bytes).toBeGreaterThan(8);
        const manifest = JSON.parse(Buffer.from(dir.files.get(MANIFEST_NAME)).toString());
        expect(manifest.models.map(m => m.modelId)).toEqual([MODEL_ID]);
        const names = manifest.models[0].entries.map(e => e.file);
        expect(names).toEqual(expect.arrayContaining(['mlc-chat-config.json', 'ndarray-cache.json', 'params_shard_0.bin', 'params_shard_1.bin', 'tokenizer.json']));
        expect(names).not.toContain('tokenizer.model');             // a tokenizer file the server doesn't have is left out, not fatal
        const fresh = fakeCaches();
        const loaded = await loadModelsFromFolder({ source: folderSource(dir), recordFor, caches: fresh, modelIds: [MODEL_ID] });
        expect(loaded.restored).toEqual([MODEL_ID]);
        expect(await cachedState(record, fresh)).toEqual({ complete: true, reason: '' });
        expect(await raw(fresh, 'model', base + 'params_shard_1.bin')).toEqual([6, 7, 8]);
    });

    test('reports progress and keeps a weight file already in the folder at the right size (a resumed download)', async () => {
        const dir = fakeDir();
        await run(dir, makeFetch());
        const again = makeFetch();
        const seen = [];
        await run(dir, again, { onProgress: p => seen.push(p.text) });
        expect(again.mock.calls.map(c => c[0])).not.toContain(base + 'params_shard_0.bin');
        expect(again.mock.calls.map(c => c[0])).not.toContain(base + 'params_shard_1.bin');
        expect(seen[seen.length - 1]).toMatch(/Downloading to the folder.*100%/);
    });

    test('a server error stops it and writes no manifest, so Load refuses the folder', async () => {
        const dir = fakeDir();
        await expect(run(dir, makeFetch({ [base + 'params_shard_1.bin']: 'FAIL' }))).rejects.toThrow(/params_shard_1\.bin.*500/);
        expect(dir.files.has(MANIFEST_NAME)).toBe(false);
    });

    test('a weight file of the wrong size is refused', async () => {
        const dir = fakeDir();
        await expect(run(dir, makeFetch({ [base + 'params_shard_0.bin']: bytes(1, 2) }))).rejects.toThrow(/instead of 5/);
        expect(dir.files.has(MANIFEST_NAME)).toBe(false);
    });

    test('a file list that points outside the model is refused', async () => {
        const dir = fakeDir();
        const evil = JSON.stringify({ records: [{ dataPath: 'https://evil.example/x.bin', nbytes: 1 }] });
        await expect(run(dir, makeFetch({ [base + 'ndarray-cache.json']: evil }))).rejects.toThrow(/outside the model/);
    });

    test('a missing compiled-code file is not fatal (WebLLM fetches it itself)', async () => {
        const dir = fakeDir();
        await run(dir, makeFetch({ [record.model_lib]: undefined }));
        const manifest = JSON.parse(Buffer.from(dir.files.get(MANIFEST_NAME)).toString());
        expect(manifest.models[0].entries.some(e => e.scope === 'wasm')).toBe(false);
    });

    test('stops when cancelled, leaving no manifest', async () => {
        const dir = fakeDir(), ctl = new AbortController();
        const fetchFn = jest.fn(async url => { ctl.abort(); return new Response(files[url] ?? 'x'); });
        await expect(run(dir, fetchFn, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(dir.files.has(MANIFEST_NAME)).toBe(false);
    });

    test('downloading or saving one size keeps the other sizes already listed in the manifest', async () => {
        const dir = fakeDir();
        await run(dir, makeFetch());
        const other = { ...record, model: 'https://huggingface.co/mlc-ai/Other-Model' };
        const otherId = LOCAL_TIERS.medium.model;
        const otherBase = locations(other).modelUrl;
        const otherFiles = {
            [otherBase + 'mlc-chat-config.json']: '{}', [otherBase + 'ndarray-cache.json']: JSON.stringify({ records: [{ dataPath: 'p.bin', nbytes: 1 }] }),
            [otherBase + 'p.bin']: bytes(1), [other.model_lib]: bytes(0),
        };
        await downloadModelToFolder({ modelId: otherId, record: other, dir, fetchFn: async url => new Response(otherFiles[url]) });
        const manifest = JSON.parse(Buffer.from(dir.files.get(MANIFEST_NAME)).toString());
        expect(manifest.models.map(m => m.modelId).sort()).toEqual([MODEL_ID, otherId].sort());
        // and loading only one of them leaves the other alone
        const fresh = fakeCaches();
        const r = await loadModelsFromFolder({ source: folderSource(dir), recordFor: id => (id === MODEL_ID ? record : id === otherId ? other : null), caches: fresh, modelIds: [otherId] });
        expect(r.restored).toEqual([otherId]);
        expect(await raw(fresh, 'model', base + 'params_shard_0.bin')).toBeNull();
    });

    test('asking for a size the folder does not hold is a NoSavedCopyError', async () => {
        const dir = fakeDir();
        await run(dir, makeFetch());
        await expect(loadModelsFromFolder({ source: folderSource(dir), recordFor, caches: fakeCaches(), modelIds: ['Nope'] })).rejects.toBeInstanceOf(NoSavedCopyError);
    });
});

describe('looking without loading anything', () => {
    test('isModelCached sees a completely cached model by id alone, and never throws', async () => {
        const c = fakeCaches();
        const guess = { model: MODEL_HOST + MODEL_ID, model_lib: '' };
        const gbase = locations(guess).modelUrl;
        expect(await isModelCached(MODEL_ID, c)).toBe(false);
        const put = async (scope, url, body) => (await c.open(SCOPES[scope])).put(new Request(url), new Response(body));
        await put('config', gbase + 'mlc-chat-config.json', '{}');
        await put('model', gbase + 'ndarray-cache.json', JSON.stringify({ records: [{ dataPath: 'a.bin', nbytes: 1 }] }));
        expect(await isModelCached(MODEL_ID, c)).toBe(false);          // a weight file is still missing
        await put('model', gbase + 'a.bin', bytes(1));
        expect(await isModelCached(MODEL_ID, c)).toBe(true);
        expect(await isModelCached(MODEL_ID, null)).toBe(false);
    });

    test('listFolderModels lists the manifest\u2019s models, or nothing for an empty or foreign folder', async () => {
        const c = fakeCaches(), dir = fakeDir();
        expect(await listFolderModels(folderSource(dir))).toEqual([]);
        await seed(c);
        await saveAll(c, dir);
        expect(await listFolderModels(folderSource(dir))).toEqual([MODEL_ID]);
        dir.files.set(MANIFEST_NAME, Buffer.from('not json'));
        expect(await listFolderModels(folderSource(dir))).toEqual([]);
    });
});
