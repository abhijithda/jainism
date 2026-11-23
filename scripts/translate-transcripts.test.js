/** @jest-environment node */
// Tests for scripts/translate-transcripts.js. The model is a fake: no network, no key, no waiting.

const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./translate-transcripts');

const A = 'bgldj0TMZB4';      // Hindi, 8 cues
const B = '3Z3uwIGj_VM';      // Hindi, 4 cues
const C = 'Daj7yBFuwh0';      // spoken in Kannada, 3 cues

const HI_A = [
    'शासन देवता की पूजा नहीं करनी चाहिए', 'अभिषेक में पंचामृत का उपयोग होता है', 'भगवान की मूर्ति के सामने बैठकर पाठ करें',
    'यह बात शास्त्रों में लिखी हुई है', 'जिनेन्द्र भगवान वीतराग होते हैं', 'सम्यक्त्व सबसे पहली चीज़ है',
    'मोक्ष का मार्ग रत्नत्रय है', 'आज की चर्चा यहीं समाप्त करते हैं',
];
const HI_B = ['नमस्कार दोस्तों आज का विषय है', 'तीर्थंकर भगवान की वाणी जिनवाणी है', 'इसे ध्यान से सुनना चाहिए', 'धन्यवाद आप सबका'];
const KN_C = ['ಇಂದಿನ ವಿಷಯ ಪೂಜೆಯ ಬಗ್ಗೆ', 'ಅಭಿಷೇಕ ಮಾಡುವ ವಿಧಾನ ಹೀಗಿದೆ', 'ಎಲ್ಲರಿಗೂ ನಮಸ್ಕಾರ'];

const cues = texts => texts.map((t, i) => [i * 10, t]);

// ── a fake Gemini ────────────────────────────────────────────────────────

const payloadOf = req => JSON.parse(req.prompt.split('\n').pop());
const langsOf = req => req.prompt.match(/for each of: ([a-z, ]+)\./)[1].split(',').map(s => s.trim());
/** A correct answer: Kannada and English text for every cue asked about. */
const good = req => ({ cues: payloadOf(req).cues.map(c => {
    const rec = { i: c.i };
    if (langsOf(req).includes('kn')) rec.kn = `ಕನ್ನಡ ${c.t}`;
    if (langsOf(req).includes('en')) rec.en = `english ${c.t}`;
    return rec;
}) });

/** `script(n, req)` may return an answer, throw, or return undefined for the correct answer. n counts calls from 1. */
function fakeAi(script, extra = {}) {
    const ai = { available: true, model: 'fake-model', calls: [], ...extra };
    ai.json = async req => {
        ai.calls.push(req);
        const r = script ? script(ai.calls.length, req) : undefined;
        return r === undefined ? good(req) : r;
    };
    return ai;
}
const err429 = () => { throw new Error('Gemini answered 429 (busy or rate-limited)'); };

const ctxOf = (over = {}) => ({
    ai: fakeAi(), source: 'hi', targets: ['kn', 'en'], glossary: [], before: () => [], log: () => {}, sleep: async () => {},
    pause: 0, cooldown: 0, max429: 3, maxRequests: 0, requests: 0, batch: 50, in429: 0, bad: 0, stopped: '', fatal: '', pauseFirst: false, ...over,
});
const itemsOf = n => Array.from({ length: n }, (_, i) => ({ i, t: `शासन देवता की पूजा ${i}` }));

// ── glossary, prompt, checking ───────────────────────────────────────────

describe('glossary', () => {
    const g = T.normalizeGlossary({ terms: [
        { hi: ['अभिषेक'], kn: 'ಅಭಿಷೇಕ', en: 'Abhisheka' },
        { hi: ['शासन देवता'], kn: 'ಶಾಸನ ದೇವತೆ' },
        { hi: ['देव मूढ\u095D\u0300'.replace('\u0300', 'ता')], kn: 'ದೇವ ಮೂಢತೆ' },     // written with the single-character nukta letter
        { hi: [], kn: 'no Hindi' },
        { hi: 'x' },
        null,
    ] });

    test('normalizeGlossary keeps only usable entries', () => {
        expect(g).toHaveLength(3);
        expect(T.normalizeGlossary(undefined)).toEqual([]);
        expect(T.normalizeGlossary([{ hi: 'तप', en: 'Tapa' }])).toEqual([{ hi: ['तप'], kn: undefined, en: 'Tapa' }]);
    });

    test('a one-word spelling matches the start of a word, a phrase must occur as written', () => {
        expect(T.termsFor(g, ['अभिषेकों का महत्व']).map(t => t.en)).toEqual(['Abhisheka']);
        expect(T.termsFor(g, ['यह शासन देवता हैं']).map(t => t.kn)).toEqual(['ಶಾಸನ ದೇವತೆ']);
        expect(T.termsFor(g, ['शासन की देवता'])).toEqual([]);
        expect(T.termsFor(g, ['पंचामृत'])).toEqual([]);
    });

    test('the two ways of writing a nukta letter are the same', () => {
        expect(T.termsFor(g, ['यह देव मूढ\u0964'.replace('\u0964', '\u0922\u093Cता है')])).toHaveLength(1);   // decomposed in the text
    });

    test('scripts/glossary.json is well formed: Kannada and Latin spellings, no duplicates', () => {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'glossary.json'), 'utf8'));
        const all = T.normalizeGlossary(raw);
        expect(raw.terms.length).toBeGreaterThan(50);
        expect(all).toHaveLength(raw.terms.length);
        for (const e of all) {
            expect(e.kn).toMatch(/[\u0C80-\u0CFF]/);
            expect(e.en).toMatch(/^[A-Za-z][A-Za-z ]*$/);
            e.hi.forEach(v => { expect(v).toMatch(/[\u0900-\u097F]/); expect(v).toBe(v.normalize('NFC')); });
        }
        expect(new Set(all.map(e => e.kn)).size).toBe(all.length);
        expect(all.some(e => e.kn === 'ಶಾಸನ ದೇವತೆ' && e.en === 'Shasana Devata')).toBe(true);
    });
});

describe('buildPrompt', () => {
    test('the payload is the last line, and the glossary lines say which spelling to use', () => {
        const items = [{ i: 4, t: 'अभिषेक होता है' }];
        const p = T.buildPrompt({ source: 'hi', targets: ['kn', 'en'], items, before: ['पहले'], terms: [{ hi: ['अभिषेक'], kn: 'ಅಭಿಷೇಕ', en: 'Abhisheka' }] });
        expect(JSON.parse(p.split('\n').pop())).toEqual({ before: ['पहले'], cues: [{ i: 4, t: 'अभिषेक होता है' }] });
        expect(p).toMatch(/Translate from Hindi into Kannada \(code "kn"\) and English \(code "en"\)/);
        expect(p).toMatch(/अभिषेक -> Kannada: ಅಭಿಷೇಕ \| English: Abhisheka/);
        expect(T.buildPrompt({ source: 'hi', targets: ['en'], items, before: [], terms: [] })).not.toMatch(/Glossary/);
    });

    test('the instructions say to translate faithfully and to leave garbled shlokas alone', () => {
        expect(T.SYSTEM).toMatch(/Do NOT correct/);
        expect(T.SYSTEM).toMatch(/EXACTLY as given/);
        expect(T.SYSTEM).toMatch(/Sanskrit or Prakrit/);
    });
});

describe('validateAnswer', () => {
    const items = [{ i: 0, t: 'शासन देवता की पूजा नहीं' }, { i: 1, t: 'अभिषेक होता है यहाँ पर' }];
    const ok = { cues: [{ i: 0, kn: 'ಶಾಸನ ದೇವತೆಯ ಪೂಜೆ ಇಲ್ಲ', en: 'no worship of shasana devata' }, { i: 1, kn: 'ಇಲ್ಲಿ ಅಭಿಷೇಕ ನಡೆಯುತ್ತದೆ', en: 'abhisheka is done here' }] };
    const check = (answer, targets = ['kn', 'en']) => T.validateAnswer(answer, items, targets);

    test('a complete answer is accepted, in any order, with spaces tidied', () => {
        const r = check({ cues: [{ ...ok.cues[1], en: '  abhisheka   is done here ' }, ok.cues[0]] });
        expect(r.ok).toBe(true);
        expect(r.out.get(1).en).toBe('abhisheka is done here');
        expect(check(ok.cues).ok).toBe(true);                                  // a bare array is accepted too
    });

    test.each([
        ['no list', {}],
        ['a cue missing', { cues: [ok.cues[0]] }],
        ['a cue twice', { cues: [ok.cues[0], ok.cues[0]] }],
        ['an unknown id (shifted ids)', { cues: [{ ...ok.cues[0], i: 5 }, ok.cues[1]] }],
        ['a non-integer id', { cues: [{ ...ok.cues[0], i: '0' }, ok.cues[1]] }],
        ['an empty English text', { cues: [{ ...ok.cues[0], en: ' ' }, ok.cues[1]] }],
        ['a missing language', { cues: [{ i: 0, kn: 'ಕನ್ನಡ ಪಠ್ಯ ಇಲ್ಲಿದೆ' }, ok.cues[1]] }],
        ['Kannada that is not Kannada', { cues: [{ ...ok.cues[0], kn: 'this is English' }, ok.cues[1]] }],
        ['English that is not English', { cues: [{ ...ok.cues[0], en: 'ಇದು ಕನ್ನಡ' }, ok.cues[1]] }],
        ['an absurdly long text', { cues: [{ ...ok.cues[0], en: 'x'.repeat(500) }, ok.cues[1]] }],
        ['an absurdly short text', { cues: [{ ...ok.cues[0], en: 'x' }, ok.cues[1]] }],
    ])('%s rejects the whole answer', (_, answer) => {
        const r = check(answer);
        expect(r.ok).toBe(false);
        expect(r.why).toBeTruthy();
    });

    test('giving a cue back unchanged (a garbled shloka) is accepted, and only the asked languages are needed', () => {
        const same = { cues: [{ i: 0, kn: items[0].t, en: items[0].t }, ok.cues[1]] };
        expect(check(same).ok).toBe(true);
        expect(check({ cues: ok.cues.map(c => ({ i: c.i, en: c.en })) }, ['en']).ok).toBe(true);
    });

    test('very short cues are not length-checked', () => {
        const r = T.validateAnswer({ cues: [{ i: 0, kn: 'ಹೌದು', en: 'Yes, indeed, that is what he said' }] }, [{ i: 0, t: 'हाँ' }], ['kn', 'en']);
        expect(r.ok).toBe(true);
    });
});

// ── asking: batches, splitting, stopping ─────────────────────────────────

describe('translateCues', () => {
    test('batches of the wanted size, and every cue comes back once', async () => {
        const ctx = ctxOf({ batch: 50 });
        const seen = [];
        const { got, failed } = await T.translateCues(ctx, itemsOf(120), (i) => seen.push(i));
        expect(ctx.requests).toBe(3);
        expect(got.size).toBe(120);
        expect(failed).toEqual([]);
        expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, i) => i));
        expect(got.get(7)).toEqual({ kn: 'ಕನ್ನಡ शासन देवता की पूजा 7', en: 'english शासन देवता की पूजा 7' });
    });

    test('the cues just before a batch are sent as context, and the matching glossary terms', async () => {
        const main = itemsOf(6).map(it => [it.i, it.t]);
        const ai = fakeAi();
        const glossary = T.normalizeGlossary([{ hi: ['शासन देवता'], kn: 'ಶಾಸನ ದೇವತೆ', en: 'Shasana Devata' }, { hi: ['अभिषेक'], kn: 'ಅಭಿಷೇಕ' }]);
        await T.translateCues(ctxOf({ ai, batch: 3, glossary, before: i => main.slice(Math.max(0, i - 3), i).map(c => c[1]) }), itemsOf(6));
        expect(payloadOf(ai.calls[0]).before).toEqual([]);
        expect(payloadOf(ai.calls[1]).before).toEqual(main.slice(0, 3).map(c => c[1]));
        expect(ai.calls[0].prompt).toMatch(/ಶಾಸನ ದೇವತೆ/);
        expect(ai.calls[0].prompt).not.toMatch(/ಅಭಿಷೇಕ/);
    });

    test('a batch that comes back with a cue missing is asked again in two halves, never filled in', async () => {
        const ai = fakeAi((n, req) => (n === 1 ? { cues: good(req).cues.slice(1) } : undefined));
        const ctx = ctxOf({ ai, batch: 10 });
        const { got, failed } = await T.translateCues(ctx, itemsOf(10));
        expect(ai.calls.map(c => payloadOf(c).cues.length)).toEqual([10, 5, 5]);
        expect(got.size).toBe(10);
        expect(failed).toEqual([]);
    });

    test('one cue that never comes back right is left out (a gap, not a shifted timestamp) and the others are kept', async () => {
        const ai = fakeAi((n, req) => (payloadOf(req).cues.some(c => c.i === 3) ? { cues: [] } : undefined));
        const { got, failed } = await T.translateCues(ctxOf({ ai, batch: 6 }), itemsOf(6));
        expect(failed).toEqual([3]);
        expect([...got.keys()].sort()).toEqual([0, 1, 2, 4, 5]);
    });

    test('answers with shifted ids are rejected, and a run of bad answers stops the run instead of burning the quota', async () => {
        const ai = fakeAi((n, req) => ({ cues: good(req).cues.map(c => ({ ...c, i: c.i + 100 })) }));
        const ctx = ctxOf({ ai, batch: 50 });
        const { got } = await T.translateCues(ctx, itemsOf(50));
        expect(got.size).toBe(0);
        expect(ctx.stopped).toBe('unreliable');
        expect(ai.calls.length).toBeLessThan(12);
    });

    test('a refusal (429) waits for the cooldown and asks the same batch again', async () => {
        const sleep = jest.fn(async () => {});
        const ai = fakeAi(n => (n === 1 ? err429() : undefined));
        const ctx = ctxOf({ ai, sleep, cooldown: 4321 });
        const { got } = await T.translateCues(ctx, itemsOf(5));
        expect(got.size).toBe(5);
        expect(ctx.stopped).toBe('');
        expect(sleep).toHaveBeenCalledWith(4321);
        expect(ai.calls).toHaveLength(2);
        expect(ai.calls[1].prompt).toBe(ai.calls[0].prompt);
    });

    test('repeated refusals stop the run cleanly, keeping what was answered before', async () => {
        const ai = fakeAi(n => (n >= 2 ? err429() : undefined));
        const ctx = ctxOf({ ai, batch: 2, max429: 3 });
        const { got } = await T.translateCues(ctx, itemsOf(8));
        expect(ctx.stopped).toBe('rate-limit');
        expect(got.size).toBe(2);                         // the first batch only
        expect(ai.calls).toHaveLength(4);                 // 1 good + 3 refused
    });

    test('a success resets the count of refusals in a row', async () => {
        const ai = fakeAi(n => (n === 1 || n === 3 || n === 5 ? err429() : undefined));
        const ctx = ctxOf({ ai, batch: 2, max429: 2 });
        const { got } = await T.translateCues(ctx, itemsOf(4));
        expect(ctx.stopped).toBe('');
        expect(got.size).toBe(4);
    });

    test('a refused key or a retired model stops at once (asking again cannot help)', async () => {
        const ai = fakeAi(() => { throw new Error('Gemini answered 404: model not found (model: gone)'); });
        const ctx = ctxOf({ ai });
        await T.translateCues(ctx, itemsOf(5));
        expect(ctx.stopped).toBe('fatal');
        expect(ctx.fatal).toMatch(/404/);
        expect(ai.calls).toHaveLength(1);
    });

    test('a network failure is not mistaken for a wrong answer forever: the run gives up after a few', async () => {
        const ai = fakeAi(() => { throw new Error('Gemini request failed: fetch failed'); });
        const ctx = ctxOf({ ai, batch: 40 });
        await T.translateCues(ctx, itemsOf(40));
        expect(ctx.stopped).toBe('unreliable');
        expect(ai.calls.length).toBeLessThanOrEqual(8);
    });

    test('--max-requests stops after that many requests', async () => {
        const ai = fakeAi();
        const ctx = ctxOf({ ai, batch: 2, maxRequests: 2 });
        const { got } = await T.translateCues(ctx, itemsOf(10));
        expect(ctx.stopped).toBe('max-requests');
        expect(ai.calls).toHaveLength(2);
        expect(got.size).toBe(4);
    });

    test('there is a pause between requests but not before the first', async () => {
        const sleep = jest.fn(async () => {});
        await T.translateCues(ctxOf({ sleep, pause: 777, batch: 2 }), itemsOf(6));
        expect(sleep.mock.calls.filter(c => c[0] === 777)).toHaveLength(2);
    });
});

// ── the command, on a temporary copy of the project ──────────────────────

describe('main, on a temporary copy of the project', () => {
    let root;
    let dir;
    let out;
    let errors;
    const deps = ai => ({ ai, sleep: async () => {}, log: m => out.push(String(m)), error: m => errors.push(String(m)) });
    const run = (argv, ai) => T.main(['--pause', '0', '--cooldown', '0', ...argv], root, deps(ai));
    const read = id => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    const write = (id, t) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(t) + '\n');
    const files = () => Object.fromEntries(fs.readdirSync(dir).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const index = () => JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));

    beforeEach(() => {
        out = []; errors = [];
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'pooja-tt-'));
        dir = path.join(root, 'assets', 'transcripts');
        fs.mkdirSync(dir, { recursive: true });
        write(A, { videoId: A, lang: 'hi-orig', source: 'captions', fetched: '2026-11-19', altChecked: '2026-11-19', segments: cues(HI_A) });
        write(B, { videoId: B, lang: 'hi-orig', source: 'captions', fetched: '2026-11-19', segments: cues(HI_B) });
        write(C, { videoId: C, lang: 'kn', source: 'manual', fetched: '2026-11-19', segments: cues(KN_C) });
        require('./fetch-transcripts').writeIndex(dir);
        fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('translates every video into the languages it is not spoken in, with the Hindi cues\u2019 own timestamps', async () => {
        const before = { A: read(A), B: read(B), C: read(C) };
        const ai = fakeAi();
        expect(await run([], ai)).toBe(0);

        const a = read(A);
        expect(a.alt.map(x => [x.lang, x.source, x.via, x.model])).toEqual([['kn', 'translated', 'gemini', 'fake-model'], ['en', 'translated', 'gemini', 'fake-model']]);
        for (const track of a.alt) {
            expect(track.segments.map(s => s[0])).toEqual(a.segments.map(s => s[0]));   // same seconds, same count, same order
            expect(track.segments).toHaveLength(HI_A.length);
        }
        expect(a.alt[0].segments[1][1]).toBe(`ಕನ್ನಡ ${HI_A[1]}`);
        expect(a.alt[1].segments[7][1]).toBe(`english ${HI_A[7]}`);
        expect(a.segments).toEqual(before.A.segments);                                 // the spoken track is untouched
        expect(a.altChecked).toBe('2026-11-19');                                       // we did not claim YouTube was asked
        expect(Object.keys(a)).toEqual(['videoId', 'lang', 'source', 'fetched', 'altChecked', 'segments', 'alt']);

        expect(read(B).alt.map(x => x.lang)).toEqual(['kn', 'en']);
        expect(read(C).alt.map(x => x.lang)).toEqual(['en']);                          // spoken in Kannada: only English is made
        expect(read(C).segments).toEqual(before.C.segments);
        expect(index()[A].alt).toEqual(['kn', 'en']);
        expect(index()[C].alt).toEqual(['en']);
    });

    test('a rerun asks for nothing', async () => {
        await run([], fakeAi());
        const ai = fakeAi();
        const snapshot = files();
        expect(await run([], ai)).toBe(0);
        expect(ai.calls).toHaveLength(0);
        expect(files()).toEqual(snapshot);
        expect(out.join('\n')).toMatch(/already translated/);
    });

    test('--force translates again what is done', async () => {
        await run([], fakeAi());
        const ai = fakeAi();
        await run(['--force', '--ids', B], ai);
        expect(ai.calls).toHaveLength(1);
        expect(read(B).alt).toHaveLength(2);
    });

    test('--dry-run shows Hindi next to Kannada and English for one video and writes nothing', async () => {
        const snapshot = files();
        const ai = fakeAi();
        expect(await run(['--dry-run', '--ids', B, '--cues', '3'], ai)).toBe(0);
        expect(files()).toEqual(snapshot);
        expect(ai.calls).toHaveLength(1);
        const text = out.join('\n');
        expect(text).toMatch(/Dry run: 3Z3uwIGj_VM, Hindi -> Kannada \+ English, the first 3 of 4 cues/);
        expect(text).toMatch(/Nothing is written/);
        expect(text).toContain(`[00:00] HI  ${HI_B[0]}`);
        expect(text).toContain(`KN  ಕನ್ನಡ ${HI_B[0]}`);
        expect(text).toContain(`EN  english ${HI_B[0]}`);
        expect(text).toContain('[00:20] HI');
        expect(text).not.toContain(HI_B[3]);                       // only the first 3
    });

    test('--dry-run without --ids uses the short video the fetch script was tried on', async () => {
        await run(['--dry-run'], fakeAi());
        expect(out.join('\n')).toMatch(/Dry run: bgldj0TMZB4/);
    });

    test('--dry-run says so when the model returns nothing usable', async () => {
        await run(['--dry-run', '--ids', B], fakeAi(() => ({ cues: [] })));
        expect(out.join('\n')).toMatch(/\(not translated\)/);
        expect(out.join('\n')).toMatch(/0 of 4 cues translated/);
    });

    test('a stopped run keeps what it had and the next run continues with only what is missing', async () => {
        const ai1 = fakeAi();
        await run(['--ids', A, '--batch', '3', '--max-requests', '1'], ai1);
        expect(ai1.calls).toHaveLength(1);
        expect(read(A).alt.find(x => x.lang === 'kn').segments).toHaveLength(3);
        expect(read(A).alt.find(x => x.lang === 'en').segments).toHaveLength(3);
        expect(out.join('\n')).toMatch(/Stopped at --max-requests/);

        const ai2 = fakeAi();
        await run(['--ids', A, '--batch', '3'], ai2);
        expect(ai2.calls.map(c => payloadOf(c).cues.map(x => x.i))).toEqual([[3, 4, 5], [6, 7]]);
        const a = read(A);
        expect(a.alt.map(x => x.segments.map(s => s[0]))).toEqual([a.segments.map(s => s[0]), a.segments.map(s => s[0])]);
    });

    test('repeated 429s stop the run with a clear message, exit 0, and the finished batches are saved', async () => {
        const ai = fakeAi(n => (n >= 2 ? err429() : undefined));
        expect(await run(['--ids', A, '--batch', '3'], ai)).toBe(0);
        const text = out.join('\n');
        expect(text).toMatch(/HTTP 429/);
        expect(text).toMatch(/midnight Pacific/);
        expect(text).toMatch(/Run the same command again/);
        expect(read(A).alt[0].segments).toHaveLength(3);
        expect(read(B).alt).toBeUndefined();                       // never reached
    });

    test('cues that never come back right leave a gap, and the next run fills just those', async () => {
        const stubborn = fakeAi((n, req) => (payloadOf(req).cues.some(c => c.i === 2) ? { cues: [] } : undefined));
        await run(['--ids', A, '--batch', '4'], stubborn);
        const kn = read(A).alt[0].segments;
        expect(kn.map(s => s[0])).toEqual([0, 10, 30, 40, 50, 60, 70]);
        expect(out.join('\n')).toMatch(/cue 2 did not come back right/);

        const ai = fakeAi();
        await run(['--ids', A], ai);
        expect(ai.calls.map(c => payloadOf(c).cues.map(x => x.i))).toEqual([[2]]);
        expect(read(A).alt[0].segments).toHaveLength(8);
    });

    test('YouTube\u2019s own translation of a language is replaced; other tracks stay; stale cues are not trusted', async () => {
        const t = read(A);
        t.alt = [
            { lang: 'kn', source: 'translated', segments: [[0, 'rough youtube kannada']] },
            { lang: 'ta', source: 'translated', segments: [[0, 'tamil']] },
            { lang: 'en', source: 'translated', via: 'gemini', model: 'old-model', segments: [[0, 'english a'], [999, 'from an older fetch of the video']] },
        ];
        write(A, t);
        const ai = fakeAi();
        await run(['--ids', A], ai);
        const a = read(A);
        expect(a.alt.map(x => x.lang)).toEqual(['kn', 'ta', 'en']);
        expect(a.alt[0].via).toBe('gemini');
        expect(a.alt[1]).toEqual({ lang: 'ta', source: 'translated', segments: [[0, 'tamil']] });
        const en = a.alt[2];
        expect(en.segments.find(s => s[0] === 999)).toBeUndefined();
        expect(en.segments[0][1]).toBe('english a');                                   // a good old cue is kept, not asked again
        expect(en.model).toBe('old-model, fake-model');
        expect(payloadOf(ai.calls[0]).cues.map(c => c.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);   // kn needs all, so all are sent
        expect(langsOf(ai.calls[0])).toEqual(['kn', 'en']);
        expect(en.segments).toHaveLength(8);
    });

    test('the glossary file is used, and only for the terms that occur', async () => {
        fs.writeFileSync(path.join(root, 'scripts', 'glossary.json'), JSON.stringify({ terms: [
            { hi: ['शासन देवता'], kn: 'ಶಾಸನ ದೇವತೆ', en: 'Shasana Devata' }, { hi: ['तप'], kn: 'ತಪ', en: 'Tapa' } ] }));
        const ai = fakeAi();
        await run(['--ids', A, '--batch', '1', '--langs', 'kn'], ai);
        expect(ai.calls[0].prompt).toMatch(/ಶಾಸನ ದೇವತೆ/);
        expect(ai.calls[1].prompt).not.toMatch(/ಶಾಸನ ದೇವತೆ/);
        expect(ai.calls[0].prompt).not.toMatch(/ತಪ/);
        expect(read(A).alt.map(x => x.lang)).toEqual(['kn']);
    });

    test('--check says what is done and what is not, without asking Gemini, and exits 1 while something is left', async () => {
        expect(await T.main(['--check'], root, deps(fakeAi()))).toBe(1);
        expect(out.join('\n')).toMatch(/todo\s+bgldj0TMZB4\s+\(hi, 8 cues\)\s+kn 0\/8, en 0\/8/);
        await run([], fakeAi());
        out = [];
        expect(await T.main(['--check'], root, deps(fakeAi()))).toBe(0);
        expect(out.join('\n')).toMatch(/3 of 3 videos fully translated/);
    });

    test('no key: says where to get a free one and exits 1 (but --check needs none)', async () => {
        expect(await run([], { available: false, json: async () => { throw new Error('no'); } })).toBe(1);
        expect(errors.join('\n')).toMatch(/GEMINI_API_KEY/);
        expect(errors.join('\n')).toMatch(/free/);
    });

    test('a refused key or retired model exits 1 and says how to change the model', async () => {
        const ai = fakeAi(() => { throw new Error('Gemini answered 404: not found (model: gone)'); });
        expect(await run([], ai)).toBe(1);
        expect(errors.join('\n')).toMatch(/GEMINI_MODEL/);
    });

    test('bad options exit 2', async () => {
        expect(await run(['--langs', 'xx'], fakeAi())).toBe(2);
        expect(await run(['--batch', 'abc'], fakeAi())).toBe(2);
        expect(await run(['--batch', '0'], fakeAi())).toBe(2);
    });

    test('a video that is not in the transcripts is named and skipped', async () => {
        await run(['--ids', 'zzzzzzzzzzz'], fakeAi());
        expect(out.join('\n')).toMatch(/No transcript for zzzzzzzzzzz/);
    });
});

describe('parseArgs', () => {
    test('flags and values', () => {
        expect(T.parseArgs(['--dry-run', '--ids', 'a,b', '--batch', '20', '--force'])).toEqual({ _: [], 'dry-run': true, ids: 'a,b', batch: '20', force: true });
    });
});
