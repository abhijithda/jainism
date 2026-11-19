/** @jest-environment node */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectVideoIds, mergeShort, parseJson3, fromWhisper, pickSubtitleFile, buildIndex, parseArgs, main } = require('./fetch-transcripts');

const ID = 'bgldj0TMZB4';
const ID2 = '3Z3uwIGj_VM';

describe('collectVideoIds', () => {
    test('finds every distinct video once, from youtubeId or from the link', () => {
        const data = [
            { blocks: [{ videos: [{ url: `https://www.youtube.com/watch?v=${ID}`, youtubeId: ID }] }] },
            { blocks: [{ videos: [{ url: `https://youtu.be/${ID2}?feature=shared` }, { url: `https://www.youtube.com/watch?v=${ID}&t=4` }] }, { videos: [{ url: 'https://example.com/x' }] }, {}] },
            {},
        ];
        expect(collectVideoIds(data)).toEqual([ID, ID2]);
        expect(collectVideoIds(undefined)).toEqual([]);
    });

    test('works on the real data.json', () => {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data.json'), 'utf8'));
        const ids = collectVideoIds(data);
        expect(ids.length).toBeGreaterThan(0);
        ids.forEach(id => expect(id).toMatch(/^[\w-]{11}$/));
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('parseJson3', () => {
    test('turns caption events into [seconds, text], dropping empty cues and immediate repeats', () => {
        const out = parseJson3({
            events: [
                { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
                { tStartMs: 2000, segs: [{ utf8: '\n' }] },
                { tStartMs: 7000, segs: [{ utf8: 'Next  line' }] },
                { tStartMs: 7500, segs: [{ utf8: 'Next line' }] },
                { tStartMs: 9000 },
                { segs: [{ utf8: 'no time' }] },
                { tStartMs: 20000, segs: [{ utf8: 'Later' }] },
            ],
        });
        expect(out).toEqual([[0, 'Hello world'], [7, 'Next line'], [20, 'Later']]);
    });

    test('joins very short cues so the file stays small, keeping the first start', () => {
        const out = parseJson3({ events: [0, 1, 2, 3, 4, 5, 6].map(s => ({ tStartMs: s * 1000, segs: [{ utf8: `w${s}` }] })) });
        expect(out[0][0]).toBe(0);
        expect(out[0][1]).toBe('w0 w1 w2 w3 w4');
        expect(out[1]).toEqual([5, 'w5 w6']);
    });

    test('bad input gives an empty list, not an exception', () => {
        expect(parseJson3(null)).toEqual([]);
        expect(parseJson3({})).toEqual([]);
        expect(parseJson3({ events: 'x' })).toEqual([]);
    });
});

describe('mergeShort / fromWhisper', () => {
    test('mergeShort does not change cues that are already far apart', () => {
        expect(mergeShort([[0, 'a'], [10, 'b'], [30, 'c']])).toEqual([[0, 'a'], [10, 'b'], [30, 'c']]);
    });

    test('Whisper output becomes cues, skipping blanks and bad times', () => {
        const out = fromWhisper({ language: 'kn', segments: [{ start: 0.4, end: 5, text: ' ನಮಸ್ಕಾರ ' }, { start: 'x', text: 'bad' }, { start: 9, text: '   ' }, { start: 30.9, text: 'later' }] });
        expect(out).toEqual([[0, 'ನಮಸ್ಕಾರ'], [30, 'later']]);
        expect(fromWhisper(null)).toEqual([]);
    });
});

describe('pickSubtitleFile', () => {
    test('takes the best language in the order given, and only this video\u2019s files', () => {
        const files = [`${ID}.en.json3`, `${ID}.hi.json3`, `${ID2}.kn.json3`, 'notes.txt'];
        expect(pickSubtitleFile(files, ID, ['kn', 'hi', 'en'])).toEqual({ file: `${ID}.hi.json3`, lang: 'hi' });
        expect(pickSubtitleFile(files, ID2, ['en'])).toEqual({ file: `${ID2}.kn.json3`, lang: 'kn' });   // anything beats nothing
        expect(pickSubtitleFile(files, 'zzzzzzzzzzz', ['en'])).toBeNull();
    });

    test('knows -orig tracks as their own language code', () => {
        expect(pickSubtitleFile([`${ID}.en-orig.json3`, `${ID}.en.json3`], ID, ['en-orig', 'en']).lang).toBe('en-orig');
    });
});

describe('parseArgs', () => {
    test('flags and values', () => {
        expect(parseArgs(['--check'])).toMatchObject({ check: true });
        expect(parseArgs(['--ids', 'a,b', '--force'])).toMatchObject({ ids: 'a,b', force: true });
        expect(parseArgs(['--import-whisper', ID, 'f.json', '--lang', 'kn'])).toMatchObject({ 'import-whisper': ID, lang: 'kn', _: ['f.json'] });
    });
});

describe('index and CLI, on a temporary copy of the project', () => {
    let root;
    let dir;
    const silence = () => { jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pooja-tr-'));
        fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(root, 'assets', 'data.json'), JSON.stringify([{ blocks: [{ videos: [{ url: `https://youtu.be/${ID}`, youtubeId: ID }, { url: `https://youtu.be/${ID2}`, youtubeId: ID2 }] }] }]));
        dir = path.join(root, 'assets', 'transcripts');
        silence();
    });
    afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

    test('--import-whisper saves the transcript and lists it in index.json', async () => {
        const whisper = path.join(root, 'w.json');
        fs.writeFileSync(whisper, JSON.stringify({ language: 'kn', segments: [{ start: 3, text: 'ಒಂದು' }, { start: 70, text: 'ಎರಡು' }] }));
        expect(await main(['--import-whisper', ID, whisper], root)).toBe(0);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8'));
        expect(saved).toMatchObject({ videoId: ID, lang: 'kn', source: 'whisper', segments: [[3, 'ಒಂದು'], [70, 'ಎರಡು']] });
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))).toEqual({ [ID]: { lang: 'kn', source: 'whisper', cues: 2, minutes: 1 } });
    });

    test('--import-whisper refuses a bad id, a missing file name and an empty transcript', async () => {
        expect(await main(['--import-whisper', 'short', 'x.json'], root)).toBe(2);
        expect(await main(['--import-whisper', ID], root)).toBe(2);
        const empty = path.join(root, 'e.json');
        fs.writeFileSync(empty, JSON.stringify({ segments: [] }));
        expect(await main(['--import-whisper', ID, empty], root)).toBe(1);
        expect(fs.existsSync(path.join(dir, `${ID}.json`))).toBe(false);
    });

    test('--check lists what is missing and exits 1; 0 once everything has a transcript', async () => {
        expect(await main(['--check'], root)).toBe(1);
        const lines = console.log.mock.calls.map(c => c[0]).join('\n');
        expect(lines).toContain('0 of 2 videos have a transcript');
        expect(lines).toContain(ID);
        fs.mkdirSync(dir, { recursive: true });
        for (const id of [ID, ID2]) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ videoId: id, segments: [[0, 'x']] }));
        expect(await main(['--check'], root)).toBe(0);
    });

    test('--reindex builds index.json from the files there and leaves broken ones out', async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${ID}.json`), JSON.stringify({ videoId: ID, lang: 'en', source: 'captions', segments: [[0, 'a'], [125, 'b']] }));
        fs.writeFileSync(path.join(dir, `${ID2}.json`), '{ not json');
        fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ segments: [[0, 'x']] }));      // not a video id
        fs.writeFileSync(path.join(dir, 'unavailable.json'), '{}');
        expect(await main(['--reindex'], root)).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))).toEqual({ [ID]: { lang: 'en', source: 'captions', cues: 2, minutes: 2 } });
        expect(console.warn.mock.calls.join(' ')).toMatch(/notes\.json/);
    });

    test('fetching without yt-dlp installed explains how to get it (free) and what to do instead, and exits 1', async () => {
        expect(await main(['--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(1);
        const said = console.error.mock.calls.map(c => c[0]).join('\n');
        expect(said).toMatch(/yt-dlp/);
        expect(said).toMatch(/free/);
        expect(said).toMatch(/Whisper/);
    });

    test('with everything already fetched there is nothing to do (and no yt-dlp needed)', async () => {
        fs.mkdirSync(dir, { recursive: true });
        for (const id of [ID, ID2]) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ videoId: id, segments: [[0, 'x']] }));
        expect(await main(['--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(0);
        expect(console.log.mock.calls.map(c => c[0]).join('\n')).toMatch(/Nothing to fetch/);
    });

    test('videos recorded as having no captions are not asked about again unless --retry-unavailable', async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'unavailable.json'), JSON.stringify({ [ID]: { checked: '2026-11-18' }, [ID2]: { checked: '2026-11-18' } }));
        expect(await main(['--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(0);                 // nothing to ask
        expect(await main(['--retry-unavailable', '--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(1);   // would ask: needs yt-dlp
    });

    // A stand-in for yt-dlp (a small script that writes the same files yt-dlp does), so the whole fetch path runs
    // without the network. Skipped on Windows, where a script can't be run as a command this way.
    const stubTest = process.platform === 'win32' ? test.skip : test;
    function writeStub() {
        const stub = path.join(root, 'fake-yt-dlp');
        fs.writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2099.01.01'); process.exit(0); }
const out = args[args.indexOf('--output') + 1];
const langs = args[args.indexOf('--sub-langs') + 1].split(',');
const id = args[args.length - 1].split('v=')[1];
const fs = require('fs');
if (id === '${ID2}') { console.error('ERROR: Video unavailable'); process.exit(1); }
const lang = langs.includes('hi') ? 'hi' : langs[0];
const events = [{ tStartMs: 1000, segs: [{ utf8: 'first words' }] }, { tStartMs: 70000, segs: [{ utf8: 'a minute later' }] }];
fs.writeFileSync(out.replace('%(id)s', id).replace('%(ext)s', lang + '.json3'), JSON.stringify({ events }));
`);
        fs.chmodSync(stub, 0o755);
        return stub;
    }

    stubTest('fetches captions through yt-dlp, saves them, records the video that had none, and indexes the rest', async () => {
        const stub = writeStub();
        expect(await main(['--yt-dlp', stub], root)).toBe(0);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8'));
        expect(saved).toMatchObject({ videoId: ID, lang: 'hi', source: 'captions', segments: [[1, 'first words'], [70, 'a minute later']] });
        expect(fs.existsSync(path.join(dir, `${ID2}.json`))).toBe(false);
        const unavailable = JSON.parse(fs.readFileSync(path.join(dir, 'unavailable.json'), 'utf8'));
        expect(Object.keys(unavailable)).toEqual([ID2]);
        expect(unavailable[ID2].why).toMatch(/unavailable/i);
        expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')))).toEqual([ID]);
    });

    stubTest('--ids limits it to those videos, and --force fetches again', async () => {
        const stub = writeStub();
        expect(await main(['--ids', ID, '--yt-dlp', stub], root)).toBe(0);
        expect(fs.existsSync(path.join(dir, 'unavailable.json'))).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'unavailable.json'), 'utf8'))).toEqual({});     // ID2 was never asked about
        const file = path.join(dir, `${ID}.json`);
        fs.writeFileSync(file, JSON.stringify({ videoId: ID, lang: 'x', source: 'manual', segments: [[0, 'hand made']] }));
        await main(['--ids', ID, '--yt-dlp', stub], root);
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).source).toBe('manual');                         // present: left alone
        await main(['--ids', ID, '--force', '--yt-dlp', stub], root);
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).source).toBe('captions');
    });

    test('buildIndex on a folder that does not exist is empty', () => {
        expect(buildIndex(path.join(root, 'nope'))).toEqual({ index: {}, skipped: [] });
    });
});
