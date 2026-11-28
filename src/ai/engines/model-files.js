// ai/engines/model-files.js — Save the on-device model to a folder on the reader's computer, and
// load it back into the browser's cache later, so clearing the browser's data doesn't mean
// downloading 1-5 GB again.
//
// How it works (checked against WebLLM 0.2.79's own source): WebLLM keeps a model in the browser's
// Cache API, one entry per file, keyed by the file's address:
//   webllm/config : mlc-chat-config.json
//   webllm/model  : ndarray-cache.json, the params_shard_N.bin weight files, the tokenizer files
//   webllm/wasm   : the model's compiled code (the record's model_lib address)
// "Save" copies those entries into plain files in a folder, plus a manifest saying which address
// each file belongs to. "Load" checks the files and puts them back under the same addresses, so the
// next time the model starts WebLLM finds everything in its cache and downloads nothing.
//
// Honest limits:
//  - Saving needs the File System Access API (Chrome, Edge and other Chromium browsers on a computer).
//    Loading also works anywhere a folder can be picked with <input webkitdirectory>.
//  - It depends on WebLLM's cache layout, which is internal and could change in a newer version. The
//    manifest records the version; a mismatch is only a warning, and anything missing is simply downloaded.
//  - Nothing here can check a weight file's contents, only its size against ndarray-cache.json.
//
// Everything that touches the browser is passed in (caches, folder handles), so the logic is testable.

import { WEBLLM_URL, LOCAL_TIERS } from '../config.js';

export const SCOPES = { config: 'webllm/config', model: 'webllm/model', wasm: 'webllm/wasm' };
export const MANIFEST_NAME = 'pooja-model-manifest.json';
export const MANIFEST_FORMAT = 1;
const SUBFOLDER = { config: 'config', model: 'model', wasm: 'wasm' };
// A file or folder name from a manifest: plain characters only, and never '.' or '..' (no walking out of the folder).
const SAFE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

/** The addresses WebLLM uses for a model record ({ model, model_lib }): same rule as WebLLM's own. */
export function locations(record) {
    let base = String(record.model);
    base += base.endsWith('/') ? '' : '/';
    if (!/.+\/resolve\/.+\//.test(base)) base += 'resolve/main/';
    const modelUrl = new URL(base).href;
    return { modelUrl, configUrl: new URL('mlc-chat-config.json', modelUrl).href, ndarrayUrl: new URL('ndarray-cache.json', modelUrl).href, wasmUrl: record.model_lib };
}

export function webllmVersion(url = WEBLLM_URL) {
    return /web-llm@([0-9][^/+]*)/.exec(url)?.[1] || '';
}

/** Is an address one that belongs to this model? Used to refuse anything else in a folder. */
export function belongsToModel(scope, url, record) {
    const { modelUrl, wasmUrl } = locations(record);
    if (scope === 'wasm') return url === wasmUrl;
    return (scope === 'config' || scope === 'model') && url.startsWith(modelUrl);
}

function fileNameFor(url, taken) {
    let name = 'file';
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file'); } catch (_) {}
    name = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file';
    let unique = name, n = 1;
    while (taken.has(unique)) unique = `${n++}_${name}`;
    taken.add(unique);
    return unique;
}

async function readJson(response) {
    try { return await response.json(); } catch (_) { return null; }
}

/**
 * Is the whole model in the browser's cache? Checks every weight file listed in ndarray-cache.json.
 * @returns {Promise<{complete: boolean, reason: string}>}
 */
export async function cachedState(record, caches) {
    const { configUrl, ndarrayUrl, modelUrl } = locations(record);
    const config = await caches.open(SCOPES.config);
    const model = await caches.open(SCOPES.model);
    if (!(await config.match(configUrl))) return { complete: false, reason: 'not downloaded' };
    const list = await model.match(ndarrayUrl);
    if (!list) return { complete: false, reason: 'not downloaded' };
    const parsed = await readJson(list);
    const shards = Array.isArray(parsed?.records) ? parsed.records : null;
    if (!shards) return { complete: false, reason: 'its file list is unreadable' };
    for (const s of shards) {
        if (!(await model.match(new URL(s.dataPath, modelUrl).href))) return { complete: false, reason: 'only partly downloaded' };
    }
    return { complete: true, reason: '' };
}

/**
 * Copies the model's cached files into `dir` (a folder handle from showDirectoryPicker) with a manifest.
 * Only models that are completely cached are saved; the manifest is written last, so an interrupted save
 * leaves a folder that Load refuses, never a half-valid one.
 *
 * @param {Array<{modelId: string, record: Object}>} models  candidates (e.g. the normal and compatibility build of a size)
 * @returns {Promise<{saved: string[], skipped: Array<{modelId: string, reason: string}>, bytes: number}>}
 */
export async function saveModelsToFolder({ models, dir, caches, onProgress = () => {}, signal }) {
    const saved = [], skipped = [], manifestModels = [];
    let bytes = 0;
    for (const { modelId, record } of models) {
        const state = await cachedState(record, caches);
        if (!state.complete) { skipped.push({ modelId, reason: state.reason }); continue; }

        const entries = [];
        const taken = { config: new Set(), model: new Set(), wasm: new Set() };
        for (const scope of ['config', 'model', 'wasm']) {
            const cache = await caches.open(SCOPES[scope]);
            const sub = await dir.getDirectoryHandle(`${modelId}-${SUBFOLDER[scope]}`.replace(/[^A-Za-z0-9._-]/g, '_'), { create: true });
            for (const request of await cache.keys()) {
                if (!belongsToModel(scope, request.url, record)) continue;
                if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                const response = await cache.match(request);
                if (!response) continue;
                const file = fileNameFor(request.url, taken[scope]);
                onProgress({ text: `Saving ${file}\u2026`, file });
                const handle = await sub.getFileHandle(file, { create: true });
                const writable = await handle.createWritable();
                let size = 0;
                if (response.body) {
                    const counter = new TransformStream({ transform(chunk, ctl) { size += chunk.byteLength; ctl.enqueue(chunk); } });
                    await response.body.pipeThrough(counter).pipeTo(writable, { signal });
                } else {
                    const buf = await response.arrayBuffer();
                    size = buf.byteLength;
                    await writable.write(buf);
                    await writable.close();
                }
                bytes += size;
                entries.push({ scope, url: request.url, folder: `${modelId}-${SUBFOLDER[scope]}`.replace(/[^A-Za-z0-9._-]/g, '_'), file, bytes: size });
            }
        }
        manifestModels.push({ modelId, entries });
        saved.push(modelId);
    }
    if (saved.length) await writeManifest(dir, manifestModels);
    return { saved, skipped, bytes };
}

/**
 * Writes the manifest, keeping the models an earlier save or download already listed (their files are still in
 * the folder), so saving or downloading one size never drops another from the list.
 */
async function writeManifest(dir, models) {
    let kept = [];
    try {
        const old = JSON.parse(await (await (await dir.getFileHandle(MANIFEST_NAME)).getFile()).text());
        if (old?.format === MANIFEST_FORMAT && Array.isArray(old.models)) kept = old.models.filter(m => m && !models.some(n => n.modelId === m.modelId));
    } catch (_) { /* no manifest yet, or an unreadable one: start a new list */ }
    const manifest = { format: MANIFEST_FORMAT, webllm: webllmVersion(), savedAt: new Date().toISOString(), models: [...kept, ...models] };
    const handle = await dir.getFileHandle(MANIFEST_NAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
}

const abortError = () => new DOMException('Aborted', 'AbortError');
const megabytes = n => Math.round(n / (1024 * 1024));

/**
 * Downloads ONE model straight into `dir` (a folder handle with write access), the same files and manifest that
 * saveModelsToFolder writes, so loadModelsFromFolder can then put it into the browser's cache. Files stream to disk
 * (never held in memory). A weight file already in the folder at the right size is kept, so an interrupted download
 * continues where it stopped. The tokenizer files and the compiled code are best effort: if one can't be fetched it is
 * left out, and WebLLM fetches it itself later. The manifest is written last.
 *
 * @param {{modelId: string, record: Object, dir: Object, fetchFn?: Function, onProgress?: Function, signal?: AbortSignal}} opts
 * @returns {Promise<{bytes: number}>}
 */
export async function downloadModelToFolder({ modelId, record, dir, fetchFn = (...a) => fetch(...a), onProgress = () => {}, signal }) {
    const { modelUrl, configUrl, ndarrayUrl, wasmUrl } = locations(record);
    const folderFor = scope => `${modelId}-${SUBFOLDER[scope]}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const taken = { config: new Set(), model: new Set(), wasm: new Set() };
    const subs = {}, entries = [];
    let done = 0, total = 0, last = 0;
    const subFor = async scope => (subs[scope] ||= await dir.getDirectoryHandle(folderFor(scope), { create: true }));
    const report = (force = false) => {
        const now = Date.now();
        if (!force && now - last < 250) return;
        last = now;
        const pct = total ? ` ${Math.min(100, Math.floor(done / total * 100))}% (${megabytes(done)} of ${megabytes(total)} MB)` : '';
        onProgress({ text: `Downloading to the folder\u2026${pct}`, done, total });
    };

    async function fetchInto(scope, url, expectBytes, countsInProgress) {
        if (signal?.aborted) throw abortError();
        const sub = await subFor(scope);
        const file = fileNameFor(url, taken[scope]);
        if (expectBytes !== undefined) {
            try {
                if ((await (await sub.getFileHandle(file)).getFile()).size === expectBytes) {
                    entries.push({ scope, url, folder: folderFor(scope), file, bytes: expectBytes });
                    if (countsInProgress) { done += expectBytes; report(); }
                    return file;
                }
            } catch (_) { /* not there yet */ }
        }
        const response = await fetchFn(url, { signal });
        if (!response.ok) throw new ModelFolderError(`Couldn\u2019t download ${file} (the server answered ${response.status}).`);
        const writable = await (await sub.getFileHandle(file, { create: true })).createWritable();
        let size = 0;
        if (response.body) {
            const counter = new TransformStream({
                transform(chunk, ctl) { size += chunk.byteLength; if (countsInProgress) { done += chunk.byteLength; report(); } ctl.enqueue(chunk); },
            });
            await response.body.pipeThrough(counter).pipeTo(writable, { signal });
        } else {
            const buf = await response.arrayBuffer();
            size = buf.byteLength;
            await writable.write(buf);
            await writable.close();
            if (countsInProgress) { done += size; report(); }
        }
        if (expectBytes !== undefined && size !== expectBytes) {
            throw new ModelFolderError(`${file} arrived at ${size} bytes instead of ${expectBytes}. Check the connection and try again.`);
        }
        entries.push({ scope, url, folder: folderFor(scope), file, bytes: size });
        return file;
    }
    const readBack = async (scope, file) => (await (await (await subFor(scope)).getFileHandle(file)).getFile()).text();
    const bestEffort = async (...args) => {
        try { await fetchInto(...args); } catch (err) { if (err?.name === 'AbortError' || signal?.aborted) throw err; }
    };

    report(true);
    const configFile = await fetchInto('config', configUrl);
    const listFile = await fetchInto('model', ndarrayUrl);
    let config = null, list = null;
    try { config = JSON.parse(await readBack('config', configFile)); } catch (_) {}
    try { list = JSON.parse(await readBack('model', listFile)); } catch (_) {}
    if (!Array.isArray(list?.records)) throw new ModelFolderError('The model\u2019s file list couldn\u2019t be read, so nothing was downloaded.');

    total = list.records.reduce((n, r) => n + (Number.isFinite(r.nbytes) ? r.nbytes : 0), 0);
    for (const shard of list.records) {
        const url = new URL(shard.dataPath, modelUrl).href;
        if (!belongsToModel('model', url, record)) throw new ModelFolderError('The model\u2019s file list names a file outside the model, so nothing was downloaded.');
        await fetchInto('model', url, Number.isFinite(shard.nbytes) ? shard.nbytes : undefined, true);
    }
    for (const name of Array.isArray(config?.tokenizer_files) ? config.tokenizer_files : []) {
        const url = typeof name === 'string' ? new URL(name, modelUrl).href : '';
        if (url && belongsToModel('model', url, record)) await bestEffort('model', url, undefined, false);
    }
    if (wasmUrl) await bestEffort('wasm', wasmUrl, undefined, false);

    report(true);
    await writeManifest(dir, [{ modelId, entries }]);
    return { bytes: entries.reduce((n, e) => n + e.bytes, 0) };
}

/** A folder picked with showDirectoryPicker, as { getFile(folder, name) -> File|null }. */
export function folderSource(dir) {
    return {
        async getFile(folder, name) {
            try {
                const sub = folder ? await dir.getDirectoryHandle(folder) : dir;
                return await (await sub.getFileHandle(name)).getFile();
            } catch (_) { return null; }
        },
    };
}

/** A folder picked with <input webkitdirectory> (a FileList), as the same kind of source. */
export function fileListSource(files) {
    const list = Array.from(files || []);
    // webkitRelativePath is "<picked folder>/<folder>/<name>"; the picked folder's own name is dropped.
    const relative = f => (f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name);
    return {
        async getFile(folder, name) {
            const tail = folder ? `${folder}/${name}` : name;
            return list.find(f => relative(f) === tail) || null;
        },
    };
}

export class ModelFolderError extends Error {}
/** The folder is fine but holds no copy of the size that was asked for (so a download may be the next step). */
export class NoSavedCopyError extends ModelFolderError {}

async function readManifest(source) {
    const file = await source.getFile('', MANIFEST_NAME);
    if (!file) throw new ModelFolderError('That folder doesn\u2019t hold a saved model. Choose the folder you saved one into (it contains a file named ' + MANIFEST_NAME + ').');
    let manifest;
    try { manifest = JSON.parse(await file.text()); } catch (_) { manifest = null; }
    if (!manifest || manifest.format !== MANIFEST_FORMAT || !Array.isArray(manifest.models)) {
        throw new ModelFolderError('That folder\u2019s model list couldn\u2019t be read. It may have been saved by a different version, or the save didn\u2019t finish.');
    }
    return manifest;
}

/**
 * Puts a saved model's files back into the browser's cache.
 * Everything is checked BEFORE the cache is touched: the manifest, that every address belongs to a model this
 * site offers, that every file is there, and that each weight file's size matches ndarray-cache.json.
 *
 * @param {Object} opts
 * @param {Object} opts.source        folderSource(...) or fileListSource(...)
 * @param {(modelId: string) => Object|null} opts.recordFor   WebLLM's record for a model id, or null if not offered
 * @param {string[]} [opts.modelIds]  only restore these models (the folder may hold other sizes); others are left alone, silently
 * @returns {Promise<{restored: string[], warnings: string[], bytes: number}>}
 */
export async function loadModelsFromFolder({ source, recordFor, caches, modelIds, onProgress = () => {}, signal }) {
    const manifest = await readManifest(source);
    const targetModels = Array.isArray(modelIds) ? manifest.models.filter(m => modelIds.includes(m?.modelId)) : manifest.models;
    if (Array.isArray(modelIds) && !targetModels.length) throw new NoSavedCopyError('That folder has no saved copy of the size you chose.');
    const warnings = [];
    if (manifest.webllm && webllmVersion() && manifest.webllm !== webllmVersion()) {
        warnings.push(`It was saved with WebLLM ${manifest.webllm} and this site uses ${webllmVersion()}; anything that doesn\u2019t match is downloaded again.`);
    }

    const plan = [];
    for (const { modelId, entries } of targetModels) {
        const record = recordFor(modelId);
        const known = Object.values(LOCAL_TIERS).some(t => t.model === modelId || t.compat === modelId);
        if (!record || !known || !Array.isArray(entries)) { warnings.push(`Skipped ${String(modelId).slice(0, 80)}: this site doesn\u2019t offer that model.`); continue; }

        const files = [];
        for (const e of entries) {
            const okScope = e && SCOPES[e.scope];
            if (!okScope || typeof e.url !== 'string' || !belongsToModel(e.scope, e.url, record)
                || !SAFE_NAME.test(String(e.file)) || !SAFE_NAME.test(String(e.folder))) {
                throw new ModelFolderError('That folder contains an entry that doesn\u2019t belong to the model, so nothing was loaded.');
            }
            const file = await source.getFile(e.folder, e.file);
            if (!file) throw new ModelFolderError(`The saved folder is missing ${e.file}, so nothing was loaded. Save the model again.`);
            if (file.size !== e.bytes) throw new ModelFolderError(`${e.file} is not the size it was saved at (damaged or incomplete), so nothing was loaded.`);
            files.push({ scope: e.scope, url: e.url, file });
        }

        // The weight files must match what the model's own file list says, byte for byte in size.
        const { modelUrl, ndarrayUrl, configUrl } = locations(record);
        const list = files.find(f => f.scope === 'model' && f.url === ndarrayUrl);
        if (!list || !files.some(f => f.scope === 'config' && f.url === configUrl)) {
            throw new ModelFolderError(`The saved copy of ${modelId} is incomplete (its configuration is missing), so nothing was loaded.`);
        }
        let parsed = null;
        try { parsed = JSON.parse(await list.file.text()); } catch (_) {}
        if (!Array.isArray(parsed?.records)) throw new ModelFolderError(`The saved copy of ${modelId} has an unreadable file list, so nothing was loaded.`);
        for (const shard of parsed.records) {
            const url = new URL(shard.dataPath, modelUrl).href;
            const f = files.find(x => x.scope === 'model' && x.url === url);
            if (!f) throw new ModelFolderError(`The saved copy of ${modelId} is missing a weight file (${shard.dataPath}), so nothing was loaded.`);
            if (Number.isFinite(shard.nbytes) && f.file.size !== shard.nbytes) {
                throw new ModelFolderError(`${shard.dataPath} is not the size the model expects (damaged or incomplete), so nothing was loaded.`);
            }
        }
        plan.push({ modelId, files });
    }
    if (!plan.length) throw new ModelFolderError('That folder has no model this site can use.');

    let bytes = 0;
    const restored = [];
    for (const { modelId, files } of plan) {
        for (const { scope, url, file } of files) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            onProgress({ text: `Loading ${file.name}\u2026`, file: file.name });
            const cache = await caches.open(SCOPES[scope]);
            // A Response built from the file streams from disk; it isn't read into memory.
            await cache.put(new Request(url), new Response(file, { headers: { 'Content-Type': scope === 'wasm' ? 'application/wasm' : file.name.endsWith('.json') ? 'application/json' : 'application/octet-stream' } }));
            bytes += file.size;
        }
        restored.push(modelId);
    }
    return { restored, warnings, bytes };
}

/** WebLLM's record for a model id, from a loaded library. */
export function recordLookup(lib) {
    const list = lib?.prebuiltAppConfig?.model_list || [];
    return modelId => list.find(m => m.model_id === modelId) || null;
}

/** Loads the library the same way the engine does (from the CDN, pinned), only when a save or load is asked for. */
export async function loadRecordLookup(load = () => import(/* webpackIgnore: true */ WEBLLM_URL)) {
    return recordLookup(await load());
}

export function canSaveToFolder(win = typeof window !== 'undefined' ? window : null) {
    return !!win && typeof win.showDirectoryPicker === 'function';
}
