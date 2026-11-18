#!/usr/bin/env node
// scripts/fetch-thumbs.js — keeps a copy of every video's thumbnail in the repo
// (assets/images/thumbs/<videoId>.jpg), so thumbnails work in the offline copy, the
// print builds don't depend on YouTube being reachable, and a video that is later
// deleted keeps the picture that shows what it was.
//
//   node scripts/fetch-thumbs.js                    download the missing ones
//   node scripts/fetch-thumbs.js --check            no network: list missing, exit 1 if any
//   node scripts/fetch-thumbs.js --retry-unavailable  look again at videos recorded as unavailable
//   node scripts/fetch-thumbs.js --force            download everything again
//   npm run thumbs                                  same as the first line
//
// It reads every video id from assets/data.json and test/data.json (the e2e fixture, so
// the screenshot tests are as deterministic as the real pages) and only
// downloads what is missing. YouTube answers a deleted or private video with
// either a 404 or a small grey placeholder picture; those are NOT saved. The
// id goes into thumbs-unavailable.json instead, so they aren't retried on every
// run, and the page falls back to YouTube's own answer at view time.
//
// Needs Node 18+ (built-in fetch), nothing else, so the GitHub workflow that runs
// it doesn't have to install the project.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..');
const DEFAULT_DATA_FILES = ['assets/data.json', 'test/data.json'];
const DEFAULT_BASE_URL = 'https://img.youtube.com/vi';
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;

// YouTube's real "0.jpg" is 480x360 and tens of KB. Its "no thumbnail" stand-ins
// are far smaller (120x90, a few KB).
const MIN_WIDTH = 320;
const MIN_HEIGHT = 180;
const MIN_BYTES = 3000;

// ── Pure helpers (exported for tests) ─────────────────────────────────────

function collectVideoIds(dataSets) {
    const ids = new Set();
    for (const data of dataSets) {
        for (const item of Array.isArray(data) ? data : []) {
            for (const block of item.blocks || []) {
                for (const video of block.videos || []) {
                    if (video && typeof video.youtubeId === 'string' && video.youtubeId) ids.add(video.youtubeId);
                }
            }
        }
    }
    return [...ids].sort();
}

// Width and height from a JPEG's start-of-frame marker, or null if not a JPEG.
function jpegSize(buf) {
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
}

function isRealThumbnail(buf) {
    if (!buf || buf.length < MIN_BYTES) return false;
    const size = jpegSize(buf);
    return !!size && size.width >= MIN_WIDTH && size.height >= MIN_HEIGHT;
}

function readUnavailable(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return new Set(Array.isArray(parsed.ids) ? parsed.ids : []);
    } catch {
        return new Set();
    }
}

function writeUnavailable(file, ids) {
    const body = {
        note: 'Videos YouTube has no thumbnail for (deleted or private). Maintained by scripts/fetch-thumbs.js; '
            + 'skipped on later runs unless --retry-unavailable is used.',
        ids: [...ids].sort(),
    };
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
}

function missingThumbnails(ids, thumbDir, unavailable) {
    return ids.filter(id => !unavailable.has(id) && !fs.existsSync(path.join(thumbDir, `${id}.jpg`)));
}

// ── Network ───────────────────────────────────────────────────────────────

async function download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return { status: res.status, body: null };
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    } finally {
        clearTimeout(timer);
    }
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }));
    return results;
}

// ── The run ───────────────────────────────────────────────────────────────

async function run({
    rootDir = DEFAULT_ROOT,
    baseUrl = process.env.THUMB_BASE_URL || DEFAULT_BASE_URL,
    dataFiles = DEFAULT_DATA_FILES,
    args = [],
    log = console.log,
} = {}) {
    const check = args.includes('--check');
    const force = args.includes('--force');
    const retryUnavailable = args.includes('--retry-unavailable');

    const thumbDir = path.join(rootDir, 'assets', 'images', 'thumbs');
    const unavailableFile = path.join(rootDir, 'thumbs-unavailable.json');

    const dataSets = dataFiles
        .map(f => path.join(rootDir, f))
        .filter(f => fs.existsSync(f))
        .map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    const ids = collectVideoIds(dataSets);
    const unavailable = retryUnavailable ? new Set() : readUnavailable(unavailableFile);
    const summary = { ids: ids.length, downloaded: [], unavailable: [], failed: [], missing: [] };

    if (check) {
        summary.missing = missingThumbnails(ids, thumbDir, unavailable);
        log(`${ids.length} videos, ${summary.missing.length} without a thumbnail`);
        summary.missing.forEach(id => log(`  missing: ${id}`));
        if (summary.missing.length) log('Run: npm run thumbs   (or the "Update Thumbnails" workflow)');
        return summary;
    }

    fs.mkdirSync(thumbDir, { recursive: true });
    const wanted = ids.filter(id => force || (!unavailable.has(id) && !fs.existsSync(path.join(thumbDir, `${id}.jpg`))));
    log(`${ids.length} videos; ${wanted.length} to fetch`);

    const allUnavailable = readUnavailable(unavailableFile);
    if (retryUnavailable) ids.forEach(id => allUnavailable.delete(id));

    await mapLimit(wanted, CONCURRENCY, async id => {
        try {
            const { status, body } = await download(`${baseUrl}/${id}/0.jpg`);
            if (status === 404 || (body && !isRealThumbnail(body))) {
                allUnavailable.add(id);
                summary.unavailable.push(id);
                log(`  ${id}: no thumbnail on YouTube (deleted or private?)`);
            } else if (body) {
                fs.writeFileSync(path.join(thumbDir, `${id}.jpg`), body);
                allUnavailable.delete(id);
                summary.downloaded.push(id);
                log(`  ${id}: saved (${Math.round(body.length / 1024)} KB)`);
            } else {
                summary.failed.push(id);
                log(`  ${id}: YouTube answered HTTP ${status}; try again later`);
            }
        } catch (err) {
            summary.failed.push(id);
            log(`  ${id}: could not fetch (${err.name === 'AbortError' ? 'timed out' : err.message}); try again later`);
        }
    });

    writeUnavailable(unavailableFile, allUnavailable);
    log(`done: ${summary.downloaded.length} saved, ${summary.unavailable.length} unavailable, ${summary.failed.length} failed`);
    return summary;
}

module.exports = {
    collectVideoIds, jpegSize, isRealThumbnail, readUnavailable, writeUnavailable,
    missingThumbnails, run,
    MIN_WIDTH, MIN_HEIGHT, MIN_BYTES,
};

if (require.main === module) {
    run({ args: process.argv.slice(2) }).then(summary => {
        const bad = process.argv.includes('--check') ? summary.missing.length : summary.failed.length;
        process.exit(bad ? 1 : 0);
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
