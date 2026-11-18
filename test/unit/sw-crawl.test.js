// The service worker saves the app by crawling it: it reads index.html, then
// every script, import and stylesheet those name, with plain text matching —
// comments and strings included. One path in it that isn't a real file (say,
// an example written in a comment) makes the install fail with a 404 and the
// whole offline copy never activates. This runs the worker's own matching
// over the project, offline, and checks every file it would fetch exists.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SCOPE = 'http://localhost/jainism/';

function loadWorkerHelpers() {
    const source = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const sandbox = { self: { registration: { scope: SCOPE }, addEventListener() {}, clients: {}, skipWaiting() {} }, URL, console };
    // The worker's top-level consts aren't visible outside it, so return what we need.
    return vm.runInNewContext(`${source}\n;({ referencesIn, inScope, keyFor, isImageUrl, imageUrlsFromData, thumbnailUrlsFromData, INDEX_URL, DATA_URL })`, sandbox);
}

function fileFor(href) {
    const u = new URL(href);
    let rel = decodeURIComponent(u.pathname.slice(new URL(SCOPE).pathname.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    return path.join(ROOT, rel);
}

function crawl() {
    const { referencesIn, inScope, keyFor, isImageUrl, INDEX_URL, DATA_URL } = loadWorkerHelpers();
    const SCANNED = /\.(?:html|js|mjs|css)$|\/$/;
    const seen = new Map();   // href -> file path
    const missing = [];       // [referenced from, href]
    const queue = [[null, INDEX_URL], [null, DATA_URL]];
    while (queue.length) {
        const [from, raw] = queue.shift();
        const href = keyFor(raw);
        if (seen.has(href)) continue;
        const file = fileFor(href);
        if (!fs.existsSync(file)) { missing.push([from, href]); continue; }
        seen.set(href, file);
        if (SCANNED.test(new URL(href).pathname)) {
            for (const ref of referencesIn(fs.readFileSync(file, 'utf8'), href)) {
                const u = new URL(ref, href);
                if (inScope(u) && !isImageUrl(u)) queue.push([path.relative(ROOT, file), u.href]);
            }
        }
    }
    return { seen, missing };
}

describe('service worker crawl', () => {
    const { seen, missing } = crawl();

    test('every file the worker would fetch exists (no path in a script, comment or style that points nowhere)', () => {
        expect(missing).toEqual([]);
    });

    test('it reaches the assistant\u2019s modules through the app\u2019s imports, so offline copies include them', () => {
        const rels = [...seen.values()].map(f => path.relative(ROOT, f).split(path.sep).join('/'));
        ['src/ai/ai-panel.js', 'src/ai/retrieval.js', 'src/ai/rag.js', 'src/ai/prompt.js', 'src/ai/engines/local.js', 'src/ai/engines/cloud.js', 'src/ai/ai-panel.css']
            .forEach(f => expect(rels).toContain(f));
    });

    test('the CDN model library is left alone (not crawled, not saved)', () => {
        const hrefs = [...seen.keys()];
        expect(hrefs.some(h => /web-llm|jsdelivr/.test(h))).toBe(false);
    });
});

describe('service worker thumbnails', () => {
    const helpers = loadWorkerHelpers();
    // The worker runs in its own vm context, so its arrays are from another realm: copy them.
    const imageUrlsFromData = text => Array.from(helpers.imageUrlsFromData(text));
    const thumbnailUrlsFromData = text => Array.from(helpers.thumbnailUrlsFromData(text));
    const data = JSON.stringify([
        { blocks: [
            { images: [{ src: 'a.jpg' }], videos: [{ url: 'https://youtu.be/aaaaaaaaaaa', youtubeId: 'aaaaaaaaaaa' }] },
            { videos: [{ url: 'x', youtubeId: 'aaaaaaaaaaa' }, { url: 'y', youtubeId: 'b-_B1234567' }] },
        ] },
        { blocks: [{ videos: [{ url: 'z' }, { url: 'w', youtubeId: 'short' }, { url: 'v', youtubeId: '../../x.js1' }, null] }] },
        { blocks: [] },
    ]);

    test('saves images/thumbs/<id>.jpg for every video id, once each', () => {
        expect(thumbnailUrlsFromData(data)).toEqual([
            `${SCOPE}images/thumbs/aaaaaaaaaaa.jpg`,
            `${SCOPE}images/thumbs/b-_B1234567.jpg`,
        ]);
    });

    test('ignores videos without a proper 11-character id (no odd paths are ever fetched)', () => {
        const urls = thumbnailUrlsFromData(data);
        expect(urls.some(u => /short|\.\.|x\.js/.test(u))).toBe(false);
    });

    test('bad or empty data gives nothing instead of throwing', () => {
        expect(thumbnailUrlsFromData('not json')).toEqual([]);
        expect(thumbnailUrlsFromData('{}')).toEqual([]);
        expect(thumbnailUrlsFromData('[]')).toEqual([]);
    });

    test('thumbnails are kept apart from the counted pictures (so a missing one never shows \u201cincomplete\u201d)', () => {
        expect(imageUrlsFromData(data)).toEqual([`${SCOPE}images/a.jpg`]);
    });
});
