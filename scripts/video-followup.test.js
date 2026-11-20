// Tests for scripts/video-followup.js. The model is a fake: no network, no key.
const fs = require('fs');
const path = require('path');
const retrieval = require('../src/ai/retrieval.js');
const { processDraft } = require('./content-agent');
const V = require('./video-followup');

const real = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data.json'), 'utf8'));
const URL_ = 'https://youtu.be/AbCdEfGhIjK';

/** A fake Gemini: the transcript call is the one that carries the video part. */
function fakeAi({ transcript, points, language = 'kn' }) {
    const calls = [];
    return {
        available: true, model: 'fake-model', calls,
        json: async (req) => {
            calls.push(req);
            if (req.parts && req.parts.length) return { language, transcript };
            return points(req);
        },
    };
}
// a clip from 12:30 to 18:30, timestamps counted from the start of the VIDEO
const transcript = [
    { ts: '12:35', text: 'ಇಂದು ನಾವು ಅಭಿಷೇಕದ ಬಗ್ಗೆ ಮಾತನಾಡೋಣ' },
    { ts: '13:10', text: 'ಜಯಧವಲದಲ್ಲಿ ವೀರಸೇನಾಚಾರ್ಯರು ಅಭಿಷೇಕದ ವಿಧಿ ಹೇಳಿದ್ದಾರೆ' },
    { ts: '14:02', text: 'ಣವಣ ಉವಲೇವಣ ಸಮ್ಮಜ್ಜಣ' },
    { ts: '16:45', text: 'ಹಾಗಾಗಿ ಚರಣಗಳಿಗೆ ಮಾತ್ರ ಚಂದನ ಹಚ್ಚುವುದು ಚುಹಾವಣ' },
];
const goodPoints = () => ({
    speakerKn: 'ಆಚಾರ್ಯ ವಿದ್ಯಾಸಾಗರ ಸ್ವಾಮಿಗಳು',
    points: [
        { en: 'Acharya Veerasena lists the steps of abhisheka in Jaya Dhavala.', kn: 'ಜಯಧವಲದಲ್ಲಿ ಅಭಿಷೇಕದ ಹಂತಗಳನ್ನು ವೀರಸೇನಾಚಾರ್ಯರು ಹೇಳಿದ್ದಾರೆ.', lines: [1] },
        { en: 'Chuhavana means sandalwood on the feet only.', kn: 'ಚುಹಾವಣ ಎಂದರೆ ಚರಣಗಳಿಗೆ ಮಾತ್ರ ಚಂದನ.', lines: [3, 3, 99] },
        { en: 'Invented point.', kn: 'ಕಲ್ಪಿತ', lines: [] },
    ],
    recitations: [2],
});
const run = (extra = {}, overrides = {}) => V.followUp(real(), {
    ai: fakeAi({ transcript, points: goodPoints, ...overrides }), target: 'A-11.2', url: URL_ + '?si=zzz', start: '12m30s', duration: '6m', speaker: 'Acharya Vidyasagar Swami', ...extra,
});

describe('time', () => {
    test('the clip window comes from --start/--duration, else the link\'s ?t=, else 0', () => {
        expect(V.clipWindow({ url: URL_, start: '12m30s', duration: '6m' })).toEqual({ id: 'AbCdEfGhIjK', start: 750, end: 1110 });
        expect(V.clipWindow({ url: URL_ + '?t=95' })).toEqual({ id: 'AbCdEfGhIjK', start: 95, end: null });
        expect(V.clipWindow({ url: URL_ })).toEqual({ id: 'AbCdEfGhIjK', start: 0, end: null });
        expect(V.clipWindow({ url: URL_ + '?t=95', start: '1:00' }).start).toBe(60);
    });
    test('mistakes are clear errors', () => {
        expect(() => V.clipWindow({ url: 'https://example.com/x' })).toThrow(/not a YouTube link/);
        expect(() => V.clipWindow({ url: URL_, start: 'soon' })).toThrow(/cannot read the start/);
        expect(() => V.clipWindow({ url: URL_, duration: 'abc' })).toThrow(/cannot read the duration/);
        expect(() => V.clipWindow({ url: URL_, duration: '5' })).toThrow(/looks like a mistake/);
    });
    test('mmss', () => { expect(V.mmss(750)).toBe('12:30'); expect(V.mmss(3723)).toBe('1:02:03'); });
    test('the video part: the public link plus clip offsets in seconds (none when there is no window)', () => {
        expect(V.videoParts({ id: 'AbCdEfGhIjK', start: 750, end: 1110 })).toEqual([{ fileData: { fileUri: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' }, videoMetadata: { startOffset: '750s', endOffset: '1110s' } }]);
        expect(V.videoParts({ id: 'AbCdEfGhIjK', start: 0, end: null })).toEqual([{ fileData: { fileUri: 'https://www.youtube.com/watch?v=AbCdEfGhIjK' } }]);
    });
    test('timestamps counted from the clip start are shifted; absolute ones are left alone', () => {
        const w = { start: 750, end: 1110 };
        const rel = V.normalizeTranscript([{ ts: '00:05', text: 'a' }, { ts: '05:40', text: 'b' }], w);
        expect(rel.mode).toBe('relative');
        expect(rel.rows.map((r) => r.sec)).toEqual([755, 1090]);
        const abs = V.normalizeTranscript([{ ts: '12:35', text: 'a' }, { ts: '18:00', text: 'b' }], w);
        expect(abs.mode).toBe('absolute');
        expect(abs.rows.map((r) => r.sec)).toEqual([755, 1080]);
        expect(V.normalizeTranscript([{ ts: '25:00', text: 'late' }], w).outside).toBe(1);
        expect(V.normalizeTranscript([{ ts: '', text: 'x' }, { ts: '00:03', text: '' }], { start: 0, end: null }).rows).toEqual([]);
    });
});

describe('the follow-up', () => {
    test('asks the model for the transcript with the video part and clip, and gives the book context to the second call', async () => {
        const ai = fakeAi({ transcript, points: goodPoints });
        await V.followUp(real(), { ai, target: 'A-11.2', url: URL_, start: '12m30s', duration: '6m' });
        expect(ai.calls[0].parts[0].videoMetadata).toEqual({ startOffset: '750s', endOffset: '1110s' });
        expect(ai.calls[0].prompt).toMatch(/between 12:30 and 18:30/);
        expect(ai.calls[1].parts).toBeUndefined();
        const hit = require('./lib/book').findBlock(real(), 'A-11.2');
        expect(ai.calls[1].prompt).toContain('TARGET A-11.2');
        expect(ai.calls[1].prompt).toMatch(/QUESTION:/);
        expect(ai.calls[1].prompt).toContain('[1] 13:10');
        expect(hit).toBeTruthy();
    });
    test('one new answer right below the answer it extends, referencing the A-11.2 block, with the next num', async () => {
        const data = real();
        const hit = require('./lib/book').findBlock(data, 'A-11.2');
        const r = await run();
        const at = data.indexOf(hit.item) + 1;
        expect(r.data).toHaveLength(data.length + 1);
        expect(r.data.slice(0, at)).toEqual(data.slice(0, at));
        expect(r.data.slice(at + 1)).toEqual(data.slice(at));
        const item = r.data[at];
        expect(item).toBe(r.item);
        expect(item.type).toBe('answer');
        expect(item.references).toEqual([hit.block.id]);
        expect(item.num).toBe(29);
        expect(item.id).toBeUndefined();
    });
    test('the paragraph block: speaker line, points in both languages, video at the clip start, only backed points kept', async () => {
        const r = await run();
        const [para] = r.item.blocks;
        expect(para.type).toBe('paragraph');
        expect(para.content.en).toEqual(['Acharya Vidyasagar Swami:', 'Acharya Veerasena lists the steps of abhisheka in Jaya Dhavala.', 'Chuhavana means sandalwood on the feet only.']);
        expect(para.content.kn[0]).toBe('ಆಚಾರ್ಯ ವಿದ್ಯಾಸಾಗರ ಸ್ವಾಮಿಗಳು:');
        expect(para.content.kn).toHaveLength(para.content.en.length);
        expect(para.videos).toEqual([{ url: 'https://youtu.be/AbCdEfGhIjK?t=750', youtubeId: 'AbCdEfGhIjK' }]);
        expect(JSON.stringify(para)).not.toMatch(/Invented point/);
    });
    test('a Sanskrit/Prakrit recitation goes in a note block (verbatim from the transcript), never a shloka', async () => {
        const r = await run();
        expect(r.item.blocks.map((b) => b.type)).toEqual(['paragraph', 'note']);
        expect(r.item.blocks[1].content.en[0]).toMatch(/verify against the source/);
        expect(r.item.blocks[1].content.en[1]).toBe('ಣವಣ ಉವಲೇವಣ ಸಮ್ಮಜ್ಜಣ');
        expect(r.item.blocks[1].content.kn[0]).toMatch(/ಪರಿಶೀಲಿಸ/);
        expect(r.item.blocks.some((b) => b.type === 'shloka')).toBe(false);
    });
    test('the report: each point beside its transcript excerpt with a timestamp link, the machine-made warning, dropped points', async () => {
        const { report } = await run();
        expect(report).toMatch(/Video follow-up of A-11\.2/);
        expect(report).toMatch(/clip 12:30 to 18:30/);
        expect(report).toContain('[13:10](https://youtu.be/AbCdEfGhIjK?t=790)');
        expect(report).toContain('ಜಯಧವಲದಲ್ಲಿ ವೀರಸೇನಾಚಾರ್ಯರು ಅಭಿಷೇಕದ ವಿಧಿ ಹೇಳಿದ್ದಾರೆ');
        expect(report).toMatch(/machine-made draft/);
        expect(report).toMatch(/Dropped 1 point/);
        expect(report).toMatch(/Sanskrit\/Prakrit recitation/);
        expect(report).toMatch(/Transcript of the clip \(4 lines\)/);
    });
    test('timestamps given from the clip start still make links that land in the right place', async () => {
        const rel = transcript.map((t, i) => ({ ts: V.mmss([5, 40, 92, 350][i]), text: t.text }));
        const { report } = await run({}, { transcript: rel });
        expect(report).toMatch(/start of the clip/);
        expect(report).toContain('[13:10](https://youtu.be/AbCdEfGhIjK?t=790)');
    });
    test('nothing added: no item, no change, and the report says so', async () => {
        const data = real();
        const r = await V.followUp(data, { ai: fakeAi({ transcript, points: () => ({ points: [], recitations: [] }) }), target: 'A-11.2', url: URL_ });
        expect(r.item).toBeNull();
        expect(r.data).toBe(data);
        expect(r.report).toMatch(/adds nothing/);
    });
    test('an empty transcript is an error that suggests what to check', async () => {
        await expect(run({}, { transcript: [] })).rejects.toThrow(/no transcript.*public/);
    });
    test('no key, an unknown block and a non-YouTube link are clear errors', async () => {
        await expect(V.followUp(real(), { ai: { available: false }, target: 'A-11.2', url: URL_ })).rejects.toThrow(/GEMINI_API_KEY/);
        await expect(run({ target: 'A-99.9' })).rejects.toThrow(/cannot find block A-99\.9/);
        await expect(run({ url: 'https://vimeo.com/1' })).rejects.toThrow(/not a YouTube link/);
    });
    test('a model that gives one language only leaves the other empty instead of breaking the line counts', async () => {
        const r = await run({}, { points: () => ({ points: [{ en: 'Only English.', lines: [0] }], recitations: [] }) });
        expect(r.item.blocks[0].content.kn).toEqual([]);
        expect(r.item.blocks[0].content.en).toEqual(['Acharya Vidyasagar Swami:', 'Only English.']);
    });
    test('then the existing pipeline: id, timestamp, block ids; references kept; no follow-up guess; the num stays', async () => {
        const r = await run();
        const out = processDraft(r.data, { retrieval, now: new Date('2026-11-19T10:00:00Z'), minScore: 1000 });
        const item = out.data[out.data.findIndex((x) => x.num === 29)];
        expect(item.id).toMatch(/^[a-z][2-9a-z]{5}$/);
        expect(item.timestamp).toBe('2026-11-19T10:00:00Z');
        expect(item.references).toEqual(r.item.references);
        expect(item.blocks.every((b) => /^[a-z][2-9a-z]{5}$/.test(b.id))).toBe(true);
    });
});
