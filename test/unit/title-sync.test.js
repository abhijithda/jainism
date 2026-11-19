// The book title is written once, in data.json's cover block. Everything the browser draws reads it from
// there; the four link-preview spots in index.html cannot (chat apps never run JavaScript), so this test
// fails when they differ from data.json — fix with `npm run sync:title`.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { syncIndexHtml, readTitle } = require(path.join(ROOT, 'scripts', 'sync-title'));
const { getBookTitle } = require(path.join(ROOT, 'src', 'core', 'book-title'));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data.json'), 'utf8'));

test('index.html link-preview title matches data.json (run: npm run sync:title)', () => {
    expect(syncIndexHtml(html, data)).toBe(html);
});

test('the sync script and the app read the same title', () => {
    const t = getBookTitle(data);
    expect(readTitle(data)).toEqual({ kn: t.kn.title, en: t.en.title });
});

test('syncIndexHtml sets all four spots, escaping &', () => {
    const d = JSON.parse(JSON.stringify(data));
    d[0].blocks[0].content = { kn: ['ಕ ಶೀ'], en: ['Q & A <1>'] };
    const out = syncIndexHtml(html, d);
    expect(out).toContain('<title>ಕ ಶೀ | Q &amp; A &lt;1&gt;</title>');
    expect(out).toContain('property="og:site_name" content="Q &amp; A &lt;1&gt;"');
    expect(out).toContain('property="og:title" content="ಕ ಶೀ | Q &amp; A &lt;1&gt;"');
    expect(out).toMatch(/property="og:image:alt" content="Q &amp; A &lt;1&gt;: /);
});

test('syncIndexHtml refuses data without a cover title', () => {
    expect(() => syncIndexHtml(html, [])).toThrow(/no cover title/);
});

test('no other place in the shipped code hard-codes the title', () => {
    const { en, kn } = getBookTitle(data);
    const files = ['src/app.js', 'src/views/book/book-view.js', 'src/home/home.js', 'scripts/render-prints.js', '.github/workflows/publish-pooja-prints.yml'];
    files.forEach(f => {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        expect([f, src.includes(en.title)]).toEqual([f, false]);
        expect([f, src.includes(kn.title)]).toEqual([f, false]);
    });
});
