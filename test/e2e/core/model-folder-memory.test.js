const { test, expect } = require('@playwright/test');

// The remembered model folder with REAL browser objects: a folder handle (from the origin-private file system,
// the same FileSystemDirectoryHandle type that showDirectoryPicker returns) must survive a round trip through
// IndexedDB, and still be usable afterwards. The unit tests use fakes; this checks the assumption they rely on.

test('a folder handle can be remembered in IndexedDB and used again', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async () => {
        const m = await import('/src/ai/engines/model-folder-memory.js');
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('pooja-memory-test', { create: true });
        await (await dir.getFileHandle('a.txt', { create: true })).createWritable().then(async w => { await w.write('hi'); await w.close(); });
        await m.forgetFolder();
        const before = await m.recallFolder();
        const remembered = await m.rememberFolder(dir);
        const back = await m.recallFolder();
        const text = back ? await (await (await back.getFileHandle('a.txt')).getFile()).text() : null;
        const access = back ? await m.folderAccess(back) : null;
        await m.forgetFolder();
        const after = await m.recallFolder();
        await root.removeEntry('pooja-memory-test', { recursive: true });
        return { before, remembered, name: back?.name, text, access, after };
    });
    expect(out).toEqual({ before: null, remembered: true, name: 'pooja-memory-test', text: 'hi', access: 'granted', after: null });
});

test('asking for persistent storage never throws', async ({ page }) => {
    await page.goto('/');
    const status = await page.evaluate(async () => (await import('/src/ai/engines/model-folder-memory.js')).requestPersistentStorage());
    expect(['granted', 'denied', 'unsupported']).toContain(status);
});
