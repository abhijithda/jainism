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
        process.env.POOJA_PAUSE_MS = '0';
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pooja-tr-'));
        fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(root, 'assets', 'data.json'), JSON.stringify([{ blocks: [{ videos: [{ url: `https://youtu.be/${ID}`, youtubeId: ID }, { url: `https://youtu.be/${ID2}`, youtubeId: ID2 }] }] }]));
        dir = path.join(root, 'assets', 'transcripts');
        silence();
    });
    afterEach(() => { delete process.env.POOJA_PAUSE_MS; jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

    test('--import-whisper saves the transcript and lists it in index.json', async () => {
        const whisper = path.join(root, 'w.json');
        fs.writeFileSync(whisper, JSON.stringify({ language: 'kn', segments: [{ start: 3, text: 'ಒಂದು' }, { start: 70, text: 'ಎರಡು' }] }));
        expect(await main(['--import-whisper', ID, whisper], root)).toBe(0);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, `${ID}.json`), 'utf8'));
        expect(saved).toMatchObject({ videoId: ID, lang: 'kn', source: 'whisper', segments: [[3, 'ಒಂದು'], [70, 'ಎರಡು']] });
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))).toEqual({ [ID]: { lang: 'kn', source: 'whisper', cues: 2, minutes: 1, alt: [] } });
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
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))).toEqual({ [ID]: { lang: 'en', source: 'captions', cues: 2, minutes: 2, alt: [] } });
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
        for (const id of [ID, ID2]) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ videoId: id, altChecked: '2026-11-19', segments: [[0, 'x']] }));
        expect(await main(['--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(0);
        expect(console.log.mock.calls.map(c => c[0]).join('\n')).toMatch(/Nothing to fetch/);
    });

    test('tracks made with Gemini count as extras already there: YouTube is not asked for them (no yt-dlp needed)', async () => {
        fs.mkdirSync(dir, { recursive: true });
        const gem = lang => ({ lang, source: 'translated', via: 'gemini', model: 'm', segments: [[0, 'x']] });
        for (const id of [ID, ID2]) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ videoId: id, lang: 'hi-orig', segments: [[0, 'x']], alt: [gem('kn'), gem('en')] }));
        expect(await main(['--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(0);
        expect(console.log.mock.calls.map(c => c[0]).join('\n')).toMatch(/Nothing to fetch/);
        // with only one of the two languages translated, the other could still come from YouTube: that needs yt-dlp
        fs.writeFileSync(path.join(dir, `${ID}.json`), JSON.stringify({ videoId: ID, lang: 'hi-orig', segments: [[0, 'x']], alt: [gem('kn')] }));
        expect(await main(['--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(1);
    });

    test('videos recorded as having no captions are not asked about again unless --retry-unavailable', async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'unavailable.json'), JSON.stringify({ [ID]: { checked: '2026-11-18' }, [ID2]: { checked: '2026-11-18' } }));
        expect(await main(['--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(0);                 // nothing to ask
        expect(await main(['--retry-unavailable', '--yt-dlp', 'definitely-not-installed-yt-dlp'], root)).toBe(1);   // would ask: needs yt-dlp
    });

    // A stand-in for yt-dlp (a small script that writes the same files yt-dlp does), so the whole fetch path runs
    // without the network. Skipped on Windows, where a script can't be run as a command this way.
    //   manual captions: none, unless the settings file says { manual: '<lang>' }.   machine captions: hi-orig (spoken), kn and en (translated).
    //   { rateLimitEn: true }: asking for the English translation is refused (HTTP 429). { rateLimitAll: true }: everything is.
    //   { rateLimitAfter: n }: every call after the n-th is refused.  { breakAuto: true }: machine captions fail with an unexplained ERROR.
    //   A refusal is a WARNING and a clean exit with no file, as in real yt-dlp: that is what once looked like "no captions".
    //   The second video does not exist. (Settings go in a file: Jest's process.env is a copy a child process never sees.)
    const stubTest = process.platform === 'win32' ? test.skip : test;
    function writeStub() {
        const stub = path.join(root, 'fake-yt-dlp');
        fs.writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2099.01.01'); process.exit(0); }
const fs = require('fs');
const out = args[args.indexOf('--output') + 1];
const langs = args[args.indexOf('--sub-langs') + 1].split(',');
const auto = args.includes('--write-auto-subs');
const id = args[args.length - 1].split('v=')[1];
const fail = msg => { console.error(msg); process.exit(1); };
const refuse = lang => { console.error("WARNING: [youtube] Unable to download video subtitles for '" + lang + "': HTTP Error 429: Too Many Requests"); process.exit(0); };
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(__dirname + '/stub-settings.json', 'utf8')); } catch (_) {}
let calls = 0;
try { calls = Number(fs.readFileSync(__dirname + '/stub-calls.txt', 'utf8')) || 0; } catch (_) {}
fs.writeFileSync(__dirname + '/stub-calls.txt', String(++calls));
console.error('WARNING: [youtube] No supported JavaScript runtime could be found.');
if (id === '${ID2}') fail('ERROR: [youtube] ${ID2}: Video unavailable');
if (cfg.rateLimitAll || (cfg.rateLimitAfter !== undefined && calls > cfg.rateLimitAfter)) refuse(langs[0]);
const events = text => [{ tStartMs: 1000, segs: [{ utf8: text + ' one' }] }, { tStartMs: 70000, segs: [{ utf8: text + ' two' }] }];
const write = lang => fs.writeFileSync(out.replace('%(id)s', id).replace('%(ext)s', lang + '.json3'), JSON.stringify({ events: events(lang) }));
if (!auto) { if (cfg.manual && langs.includes(cfg.manual)) write(cfg.manual); process.exit(0); }
if (langs.includes('en') && cfg.rateLimitEn) refuse('en');
if (cfg.breakAuto) fail('ERROR: Unable to download webpage: boom');
for (const l of ['hi-orig', 'kn', 'en']) if (langs.includes(l)) { write(l); break; }
`);
        fs.chmodSync(stub, 0o755);
        return stub;
    }
    const stubSettings = settings => {
        fs.writeFileSync(path.join(root, 'stub-settings.json'), JSON.stringify(settings));
        fs.rmSync(path.join(root, 'stub-calls.txt'), { force: true });          // the call counter starts again
    };
    const file = id => path.join(dir, `${id}.json`);
    const saved = id => JSON.parse(fs.readFileSync(file(id), 'utf8'));
    const said = () => console.log.mock.calls.map(c => c[0]).join('\n');

    stubTest('fetches the spoken-language captions plus the Kannada and English translations, and records the video that does not exist', async () => {
        const stub = writeStub();
        expect(await main(['--yt-dlp', stub], root)).toBe(0);
        const t = saved(ID);
        expect(t).toMatchObject({ videoId: ID, lang: 'hi-orig', source: 'captions', segments: [[1, 'hi-orig one'], [70, 'hi-orig two']] });
        expect(t.alt.map(a => [a.lang, a.source])).toEqual([['kn', 'translated'], ['en', 'translated']]);
        expect(t.alt[0].segments).toEqual([[1, 'kn one'], [70, 'kn two']]);
        expect(t.altChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(fs.existsSync(file(ID2))).toBe(false);
        const unavailable = JSON.parse(fs.readFileSync(path.join(dir, 'unavailable.json'), 'utf8'));
        expect(Object.keys(unavailable)).toEqual([ID2]);
        expect(unavailable[ID2].why).toMatch(/Video unavailable/);            // yt-dlp's own words, not a vague "no captions"
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))).toEqual({ [ID]: { lang: 'hi-orig', source: 'captions', cues: 2, minutes: 1, alt: ['kn', 'en'] } });
    });

    stubTest('captions someone uploaded win over YouTube\u2019s machine ones, and are marked as such', async () => {
        stubSettings({ manual: 'hi' });
        expect(await main(['--ids', ID, '--yt-dlp', writeStub()], root)).toBe(0);
        expect(saved(ID)).toMatchObject({ lang: 'hi', source: 'manual', segments: [[1, 'hi one'], [70, 'hi two']] });
    });

    stubTest('a translation YouTube refuses (429) is reported, what was got is kept, and the video is not marked done: a rerun adds the rest', async () => {
        stubSettings({ rateLimitEn: true });
        const stub = writeStub();
        expect(await main(['--ids', ID, '--yt-dlp', stub], root)).toBe(0);
        expect(said()).toMatch(/refused by YouTube/);
        let t = saved(ID);
        expect(t.alt.map(a => a.lang)).toEqual(['kn']);
        expect(t.altChecked).toBeUndefined();

        stubSettings({});
        console.log.mockClear();
        expect(await main(['--ids', ID, '--yt-dlp', stub], root)).toBe(0);
        t = saved(ID);
        expect(t.alt.map(a => a.lang)).toEqual(['kn', 'en']);                  // main track untouched, translations completed
        expect(t.segments).toEqual([[1, 'hi-orig one'], [70, 'hi-orig two']]);
        expect(t.altChecked).toBeDefined();
        expect(said()).toMatch(/extras:/);
    });

    stubTest('a main-track request that YouTube refuses is NOT recorded as "no captions"', async () => {
        stubSettings({ rateLimitAll: true });
        expect(await main(['--ids', ID, '--yt-dlp', writeStub()], root)).toBe(0);
        expect(fs.existsSync(file(ID))).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'unavailable.json'), 'utf8'))).toEqual({});
        expect(said()).toMatch(/refused by YouTube.*not recorded/);
    });

    stubTest('--alt-langs none keeps only the main track; a video that already has one is then left alone', async () => {
        const stub = writeStub();
        expect(await main(['--ids', ID, '--alt-langs', 'none', '--yt-dlp', stub], root)).toBe(0);
        expect(saved(ID).alt).toBeUndefined();
        expect(saved(ID).altChecked).toBeUndefined();
        console.log.mockClear();
        expect(await main(['--ids', ID, '--alt-langs', 'none', '--yt-dlp', stub], root)).toBe(0);
        expect(said()).toMatch(/Nothing to fetch/);
    });

    stubTest('a transcript made before translated tracks existed gets them added, without refetching the main track', async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file(ID), JSON.stringify({ videoId: ID, lang: 'hi-orig', source: 'captions', fetched: '2026-11-18', segments: [[1, 'old hindi']] }));
        expect(await main(['--check'], root)).toBe(1);                         // ID2 is still missing
        expect(said()).toMatch(/could still get Kannada\/English translated tracks/);
        expect(await main(['--ids', ID, '--yt-dlp', writeStub()], root)).toBe(0);
        const t = saved(ID);
        expect(t.segments).toEqual([[1, 'old hindi']]);
        expect(t.fetched).toBe('2026-11-18');
        expect(t.alt.map(a => a.lang)).toEqual(['kn', 'en']);
    });

    stubTest('--force fetches everything again, and a Whisper transcript keeps the translated tracks the video already had', async () => {
        const stub = writeStub();
        await main(['--ids', ID, '--yt-dlp', stub], root);
        const whisper = path.join(root, 'w.json');
        fs.writeFileSync(whisper, JSON.stringify({ language: 'hi', segments: [{ start: 5, text: 'whisper words' }] }));
        await main(['--import-whisper', ID, whisper], root);
        expect(saved(ID)).toMatchObject({ source: 'whisper', segments: [[5, 'whisper words']] });
        expect(saved(ID).alt.map(a => a.lang)).toEqual(['kn', 'en']);
        await main(['--ids', ID, '--force', '--yt-dlp', stub], root);
        expect(saved(ID).source).toBe('captions');
    });

    stubTest('YouTube refusing requests stops the run at the first refusal; what was fetched is already saved, and a rerun finishes the rest', async () => {
        const [ID3, ID4] = ['AAAAAAAAAAA', 'BBBBBBBBBBB'];
        fs.writeFileSync(path.join(root, 'assets', 'data.json'), JSON.stringify([{ blocks: [{ videos: [ID, ID3, ID4].map(id => ({ url: `https://youtu.be/${id}`, youtubeId: id })) }] }]));
        const stub = writeStub();
        stubSettings({ rateLimitAfter: 2 });                  // the first video's two requests succeed, the next is refused
        expect(await main(['--alt-langs', 'none', '--yt-dlp', stub], root)).toBe(0);
        expect(fs.existsSync(file(ID))).toBe(true);
        expect(fs.existsSync(file(ID3))).toBe(false);
        expect(fs.existsSync(file(ID4))).toBe(false);                      // never asked: it stopped
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'unavailable.json'), 'utf8'))).toEqual({});   // a refusal is not "no captions"
        expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')))).toEqual([ID]);   // saved as it went
        expect(said()).toMatch(/refused by YouTube/);
        expect(said()).toMatch(/run the same command again/);

        stubSettings({});
        console.log.mockClear();
        expect(await main(['--yt-dlp', stub], root)).toBe(0);
        for (const id of [ID, ID3, ID4]) expect(saved(id).alt.map(a => a.lang)).toEqual(['kn', 'en']);
        expect(saved(ID).segments).toEqual([[1, 'hi-orig one'], [70, 'hi-orig two']]);
    });

    stubTest('main tracks of every video come before any translated extras', async () => {
        const ID3 = 'AAAAAAAAAAA';
        fs.writeFileSync(path.join(root, 'assets', 'data.json'), JSON.stringify([{ blocks: [{ videos: [ID, ID3].map(id => ({ url: `https://youtu.be/${id}`, youtubeId: id })) }] }]));
        const written = [];
        jest.spyOn(process.stdout, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
        expect(await main(['--yt-dlp', writeStub()], root)).toBe(0);
        const order = written.map(l => l.match(/^\[(main|extras)/)).filter(Boolean).map(m => m[1]);
        expect(order).toEqual(['main', 'main', 'extras', 'extras']);
    });

    stubTest('an unexplained yt-dlp failure is shown, and is not recorded as "no captions"', async () => {
        stubSettings({ breakAuto: true });
        expect(await main(['--ids', ID, '--yt-dlp', writeStub()], root)).toBe(0);
        expect(said()).toMatch(/failed \(ERROR: Unable to download webpage: boom\)/);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'unavailable.json'), 'utf8'))).toEqual({});
        expect(fs.existsSync(file(ID))).toBe(false);
    });

    stubTest('--verbose shows what yt-dlp says (but not its JavaScript-runtime nag)', async () => {
        stubSettings({ rateLimitEn: true });
        await main(['--ids', ID, '--verbose', '--yt-dlp', writeStub()], root);
        expect(said()).toMatch(/yt-dlp \(auto en\):.*429/);
        expect(said()).not.toMatch(/JavaScript runtime/);
    });

    test('buildIndex on a folder that does not exist is empty', () => {
        expect(buildIndex(path.join(root, 'nope'))).toEqual({ index: {}, skipped: [] });
    });
});
