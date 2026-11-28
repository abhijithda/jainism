// The two folder offers Local makes just before it would download its model, seen through the drawer:
// load a saved copy from the remembered folder, or download into a folder first and load from there.
// The engine, the folder code and the browser's folder picker are fakes; the real pieces have their own tests.

const fs = require('fs');
const path = require('path');
const { LOCAL_TIERS } = require('./config');

const MODEL = LOCAL_TIERS.small.model;
const IDS = [LOCAL_TIERS.small.model, LOCAL_TIERS.small.compat];
const mockEngine = { id: 'local', generate: jest.fn(), prepare: jest.fn(), available: () => ({ ok: true }) };
jest.mock('./engines/index.js', () => ({ getEngine: () => mockEngine }));
jest.mock('./engines/model-files.js', () => ({
    ...jest.requireActual('./engines/model-files.js'),
    loadRecordLookup: jest.fn(),
    loadModelsFromFolder: jest.fn(),
    downloadModelToFolder: jest.fn(),
}));
jest.mock('./engines/model-folder-memory.js', () => ({
    ...jest.requireActual('./engines/model-folder-memory.js'),
    recallFolder: jest.fn(),
    rememberFolder: jest.fn(),
    folderAccess: jest.fn(),
}));

const files = require('./engines/model-files.js');
const memory = require('./engines/model-folder-memory.js');
const { initAi } = require('./ai-panel');
const { saveSettings } = require('../core/settings');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'data.json'), 'utf8'));

const flush = () => new Promise(r => setTimeout(r, 0));
const buttons = () => [...document.querySelectorAll('#ai-messages button.ai-retry')];
const press = async label => { buttons().find(b => b.textContent === label).click(); await flush(); };
const messages = () => document.getElementById('ai-messages').textContent;
async function startAsk() {
    document.getElementById('ai-input').value = 'shasana devata';
    document.getElementById('ai-send').click();
    await flush(); await flush();
}
async function finish() { for (let i = 0; i < 40 && document.getElementById('ai-send').disabled; i++) await flush(); }

const lookup = jest.fn(id => ({ model_id: id }));
let picker;

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    saveSettings({ aiEngine: 'local' });
    document.body.innerHTML = '<button id="ai-btn"></button><select id="ai-engine-select"><option value="local"></option></select><span id="ai-engine-note"></span>';
    mockEngine.generate.mockReset().mockResolvedValue('Ok [A-1.1].');
    mockEngine.prepare.mockReset().mockImplementation(async (_cb, { beforeDownload } = {}) => { await beforeDownload({ modelIds: IDS, modelId: MODEL }); });
    files.loadRecordLookup.mockReset().mockResolvedValue(lookup);
    files.loadModelsFromFolder.mockReset().mockResolvedValue({ restored: [MODEL], warnings: [], bytes: 1 });
    files.downloadModelToFolder.mockReset().mockResolvedValue({ bytes: 1 });
    memory.recallFolder.mockReset().mockResolvedValue(null);
    memory.rememberFolder.mockReset().mockResolvedValue(true);
    memory.folderAccess.mockReset().mockResolvedValue('granted');
    picker = jest.fn().mockResolvedValue({ name: 'models' });
    window.showDirectoryPicker = picker;
    window.caches = {};
    initAi({ data, onCite: jest.fn() });
});
afterEach(() => { delete window.showDirectoryPicker; delete window.caches; });

describe('a folder is already remembered', () => {
    const saved = { name: 'saved-models' };
    beforeEach(() => memory.recallFolder.mockResolvedValue(saved));

    test('when the browser still allows reading, the copy loads without a question and only the chosen size is asked for', async () => {
        await startAsk(); await finish();
        expect(buttons()).toHaveLength(0);
        expect(files.loadModelsFromFolder).toHaveBeenCalledTimes(1);
        expect(files.loadModelsFromFolder.mock.calls[0][0].modelIds).toEqual(IDS);
        expect(files.downloadModelToFolder).not.toHaveBeenCalled();
        expect(picker).not.toHaveBeenCalled();
    });

    test('otherwise it asks once, and asks the browser for read access in that click', async () => {
        memory.folderAccess.mockImplementation(async (_h, opts = {}) => (opts.request ? 'granted' : 'prompt'));
        await startAsk();
        expect(messages()).toMatch(/Load the saved model from the folder .saved-models./);
        await press('Load from folder'); await finish();
        expect(memory.folderAccess).toHaveBeenCalledWith(saved, { request: true });
        expect(files.loadModelsFromFolder).toHaveBeenCalledTimes(1);
        expect(files.downloadModelToFolder).not.toHaveBeenCalled();
    });

    test('"Download instead" goes straight to the normal download, with no second question', async () => {
        memory.folderAccess.mockResolvedValue('prompt');
        await startAsk();
        await press('Download instead'); await finish();
        expect(files.loadModelsFromFolder).not.toHaveBeenCalled();
        expect(files.downloadModelToFolder).not.toHaveBeenCalled();
        expect(buttons().every(b => b.disabled)).toBe(true);
        expect(mockEngine.generate).toHaveBeenCalled();
    });

    test('a folder without this size says so, then offers to download into that same folder', async () => {
        files.loadModelsFromFolder.mockRejectedValueOnce(new files.NoSavedCopyError('That folder has no saved copy of the size you chose.'));
        await startAsk();
        expect(messages()).toMatch(/no saved copy of this size/);
        expect(messages()).toMatch(/Download the small model .*into the folder .saved-models./);
        await press('Download into the folder'); await finish();
        expect(memory.folderAccess).toHaveBeenCalledWith(saved, { request: true, mode: 'readwrite' });
        expect(picker).not.toHaveBeenCalled();                      // the remembered folder is used, nothing to pick
        expect(files.downloadModelToFolder.mock.calls[0][0]).toMatchObject({ modelId: MODEL, dir: saved });
    });
});

describe('no folder remembered yet', () => {
    test('offers to download into a folder first; "Browser only" leaves the normal download alone', async () => {
        await startAsk();
        expect(messages()).toMatch(/Download the small model \(about 1 GB\) into a folder .* disk space twice/);
        await press('Browser only'); await finish();
        expect(picker).not.toHaveBeenCalled();
        expect(files.downloadModelToFolder).not.toHaveBeenCalled();
        expect(mockEngine.generate).toHaveBeenCalled();
    });

    test('"Choose a folder": picks it (with write access), downloads only the chosen build, loads it, and remembers the folder', async () => {
        await startAsk();
        await press('Choose a folder'); await finish();
        expect(picker).toHaveBeenCalledWith({ mode: 'readwrite', id: 'pooja-model' });
        expect(files.downloadModelToFolder).toHaveBeenCalledTimes(1);
        expect(files.downloadModelToFolder.mock.calls[0][0]).toMatchObject({ modelId: MODEL, dir: { name: 'models' } });
        expect(files.loadModelsFromFolder.mock.calls[0][0].modelIds).toEqual([MODEL]);
        expect(memory.rememberFolder).toHaveBeenCalledWith({ name: 'models' });
        expect(mockEngine.generate).toHaveBeenCalled();
    });

    test('cancelling the folder picker falls back to the browser download', async () => {
        picker.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        await startAsk();
        await press('Choose a folder'); await finish();
        expect(messages()).toMatch(/No folder chosen/);
        expect(files.downloadModelToFolder).not.toHaveBeenCalled();
        expect(mockEngine.generate).toHaveBeenCalled();
    });

    test('a failed download into the folder is explained, and the browser download still goes ahead', async () => {
        files.downloadModelToFolder.mockRejectedValue(new Error('The disk is full.'));
        await startAsk();
        await press('Choose a folder'); await finish();
        expect(messages()).toMatch(/The disk is full\. The model will be downloaded into the browser only/);
        expect(files.loadModelsFromFolder).not.toHaveBeenCalled();
        expect(mockEngine.generate).toHaveBeenCalled();
    });

    test('without a folder picker (not Chrome/Edge on a computer) nothing is asked', async () => {
        delete window.showDirectoryPicker;
        await startAsk(); await finish();
        expect(buttons()).toHaveLength(0);
        expect(mockEngine.generate).toHaveBeenCalled();
    });
});
