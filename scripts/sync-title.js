#!/usr/bin/env node
// scripts/sync-title.js — Writes the book's title into the four link-preview
// spots in index.html (<title>, og:site_name, og:title, og:image:alt), taken from
// data.json's cover block. Chat apps read those tags from the raw HTML without
// running JavaScript, so they cannot be filled in by the browser; everything else
// that shows the title already reads data.json at run time (core/book-title.js).
//
//   npm run sync:title            # rewrite index.html if it is out of date
//   npm run sync:title -- --check # only report; exit 1 if out of date
//
// title-sync.test.js runs the same check, so a changed title that was not synced
// fails the tests. og-image.jpg has the title drawn into the picture and has to be
// redone by hand (see README, "Link preview").

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALT_SUFFIX = 'a carved stone relief of a seated Tirthankara';   // what the picture shows

// Same rule as core/book-title.js getBookTitle (that one is an ES module for the
// browser; title-sync.test.js checks the two agree).
function readTitle(data) {
    const cover = data?.[0]?.type === 'insert' ? data[0] : null;
    const content = cover?.blocks?.[0]?.content || {};
    const first = lang => ((Array.isArray(content[lang]) ? content[lang] : [])
        .map(l => String(l ?? '').trim()).filter(Boolean))[0] || '';
    return { kn: first('kn'), en: first('en') };
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Returns index.html with the four spots set from data. Throws if one is missing. */
function syncIndexHtml(html, data) {
    const t = readTitle(data);
    if (!t.kn || !t.en) throw new Error('data.json has no cover title (data[0].blocks[0].content kn/en)');
    const both = esc(`${t.kn} | ${t.en}`);
    const subs = [
        [/(<title>)[^<]*(<\/title>)/, `$1${both}$2`],
        [/(<meta property="og:site_name" content=")[^"]*(">)/, `$1${esc(t.en)}$2`],
        [/(<meta property="og:title" content=")[^"]*(">)/, `$1${both}$2`],
        [/(<meta property="og:image:alt" content=")[^"]*(">)/, `$1${esc(`${t.en}: ${ALT_SUFFIX}`)}$2`],
    ];
    let out = html;
    for (const [re, to] of subs) {
        if (!re.test(out)) throw new Error(`index.html: could not find ${re}`);
        out = out.replace(re, to);
    }
    return out;
}

module.exports = { readTitle, syncIndexHtml };

if (require.main === module) {
    const dataPath = path.join(ROOT, 'assets', 'data.json');
    const htmlPath = path.join(ROOT, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const next = syncIndexHtml(html, JSON.parse(fs.readFileSync(dataPath, 'utf8')));
    if (next === html) {
        console.log('index.html already matches the title in data.json.');
    } else if (process.argv.includes('--check')) {
        console.error('index.html is out of date with the title in data.json — run: npm run sync:title');
        process.exit(1);
    } else {
        fs.writeFileSync(htmlPath, next);
        console.log('index.html updated from the title in data.json. Redo assets/images/og-image.jpg if the picture shows the old title.');
    }
}
