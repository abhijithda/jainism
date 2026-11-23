// The data the video navigator reads: assets/transcripts/* and the `marks` in data.json.
// A malformed file would silently make a video unsearchable, so it fails the build instead.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'assets', 'transcripts');
const ID = /^[\w-]{11}$/;
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data.json'), 'utf8'));
const { parseClock } = require('../../src/core/video-time');

const videoIds = new Set();
const marks = [];
data.forEach(item => (item.blocks || []).forEach(block => (block.videos || []).forEach(v => {
    videoIds.add(v.youtubeId);
    (v.marks || []).forEach(m => marks.push({ block: block.id, video: v.youtubeId, ...m }));
})));

describe('assets/transcripts', () => {
    const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));

    test('index.json exists and is an object (the page reads it before anything else)', () => {
        expect(index && typeof index === 'object' && !Array.isArray(index)).toBe(true);
    });

    test('every listed transcript is a video the book links, has a file, and the file is well formed', () => {
        for (const [id, info] of Object.entries(index)) {
            expect(id).toMatch(ID);
            expect(videoIds.has(id)).toBe(true);
            const file = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
            expect(file.videoId).toBe(id);
            expect(['captions', 'whisper', 'manual']).toContain(file.source);
            expect(Array.isArray(file.segments) && file.segments.length).toBeTruthy();
            expect(info.cues).toBe(file.segments.length);
            const checkCues = cues => {
                let previous = -1;
                for (const [s, t] of cues) {
                    expect(Number.isInteger(s) && s >= 0).toBe(true);
                    expect(typeof t === 'string' && t.trim() !== '').toBe(true);
                    expect(s).toBeGreaterThanOrEqual(previous);
                    previous = s;
                }
            };
            checkCues(file.segments);
            // translated tracks (Kannada/English machine translations of the spoken track): same shape, marked as such
            const alt = file.alt || [];
            expect(alt.map(a => a.lang)).toEqual(info.alt || []);
            alt.forEach(a => {
                expect(typeof a.lang === 'string' && a.lang !== '').toBe(true);
                expect(a.source).toBe('translated');
                expect(a.segments.length).toBeGreaterThan(0);
                checkCues(a.segments);
                // made with Gemini (scripts/translate-transcripts.js): each cue sits exactly on a cue of the spoken track,
                // so a hit opens the video at the same second as the words it was translated from
                if (a.via) {
                    expect(a.via).toBe('gemini');
                    expect(typeof a.model === 'string' && a.model !== '').toBe(true);
                    const starts = new Set(file.segments.map(s => s[0]));
                    a.segments.forEach(([s]) => expect(starts.has(s)).toBe(true));
                    expect(a.segments.length).toBeLessThanOrEqual(file.segments.length);
                }
            });
        }
    });

    test('every transcript file on disk is listed (run: node scripts/fetch-transcripts.js --reindex)', () => {
        const onDisk = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && !['index.json', 'unavailable.json'].includes(f)).map(f => f.slice(0, -5));
        expect(onDisk.sort()).toEqual(Object.keys(index).sort());
    });
});

describe('video marks in data.json', () => {
    test('each mark has a readable time and a label', () => {
        marks.forEach(m => {
            expect(parseClock(m.t)).not.toBeNull();
            expect(String(m.label).trim()).not.toBe('');
        });
    });
});
