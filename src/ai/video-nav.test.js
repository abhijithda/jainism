const { collectVideos, normalizeTranscript, windowSegments, loadTranscripts, createVideoIndex, findMoments } = require('./video-nav');

const V1 = 'AAAAAAAAAAA';
const V2 = 'BBBBBBBBBBB';
const V3 = 'CCCCCCCCCCC';

// Two questions with answers; the answers carry videos. Labels come from item type + number + block num.
function fixture() {
    return [
        { id: 'q1', type: 'question', num: 1, blocks: [{ id: 'bq1', num: 1, type: 'paragraph', content: { kn: [], en: ['How is abhisheka done?'] }, tags: ['Abhisheka'] }] },
        {
            id: 'a1', type: 'answer', references: ['q1'], blocks: [{
                id: 'ba1', num: 1, type: 'paragraph',
                content: { kn: ['ಅಭಿಷೇಕ ನೀರಿನಿಂದ ಮಾಡಲಾಗುತ್ತದೆ'], en: ['Abhisheka is done with water and milk.'] },
                tags: ['Abhisheka', 'Panchamrita'],
                videos: [{ url: `https://www.youtube.com/watch?v=${V1}&t=1m30s`, youtubeId: V1 }],
            }],
        },
        {
            id: 'a2', type: 'answer', num: 2, blocks: [{
                id: 'ba2', num: 1, type: 'paragraph',
                content: { kn: [], en: ['Shasana devata may be honoured but not worshipped as bhagawan.'] },
                tags: ['Shasana Devata'],
                videos: [{ url: `https://youtu.be/${V2}?feature=shared`, youtubeId: V2, marks: [{ t: '12:34', label: 'Padmavati devi worship explained' }, { t: 'bad', label: 'ignored' }, { t: 5, label: '' }] }],
            }],
        },
        {
            id: 'a3', type: 'answer', num: 3, blocks: [{
                id: 'ba3', num: 1, type: 'paragraph', content: { kn: [], en: ['Giving food is aahara daana.'] }, tags: ['Aahara Daana'],
                videos: [{ url: `https://www.youtube.com/watch?v=${V3}`, youtubeId: V3 }],
            }],
        },
    ];
}

const transcript = (lines, extra = {}) => ({ lang: 'en', source: 'captions', ...extra, segments: lines.map(([s, t]) => [s, t]) });

describe('collectVideos', () => {
    test('lists each video once, with the block it is attached to, its label and its link\u2019s start time', () => {
        const videos = collectVideos(fixture());
        expect([...videos.keys()]).toEqual([V1, V2, V3]);
        const owner = videos.get(V1).owners[0];
        expect(owner.blockId).toBe('ba1');
        expect(owner.label).toBe('A-1.1');       // labels work even if nothing else built the block index first
        expect(owner.start).toBe(90);
        expect(owner.tags).toContain('Panchamrita');
        expect(videos.get(V2).owners[0].start).toBe(0);
    });

    test('reads marks in clock or seconds form and drops unreadable or unlabelled ones', () => {
        expect(collectVideos(fixture()).get(V2).marks).toEqual([{ t: 754, label: 'Padmavati devi worship explained' }]);
    });

    test('a video attached to two blocks has two owners; a missing youtubeId falls back to the link', () => {
        const data = fixture();
        data[2].blocks[0].videos[0] = { url: `https://www.youtube.com/watch?v=${V1}` };
        const videos = collectVideos(data);
        expect(videos.get(V1).owners.map(o => o.blockId)).toEqual(['ba1', 'ba2']);
    });

    test('ignores links that are not YouTube videos, and empty data', () => {
        const data = fixture();
        data[2].blocks[0].videos[0] = { url: 'https://example.com/x', youtubeId: 'nope' };
        expect(collectVideos(data).has(V2)).toBe(false);
        expect(collectVideos(undefined).size).toBe(0);
    });
});

describe('normalizeTranscript', () => {
    test('accepts array cues, {s,t} and {start,text}, sorts them and cleans spaces', () => {
        const t = normalizeTranscript({ lang: 'kn', source: 'whisper', segments: [[20, '  later   line '], { s: 5, t: 'first' }, { start: '1:00', text: 'minute' }] });
        expect(t.lang).toBe('kn');
        expect(t.source).toBe('whisper');
        expect(t.segments).toEqual([{ s: 5, t: 'first' }, { s: 20, t: 'later line' }, { s: 60, t: 'minute' }]);
    });

    test('drops broken cues; nothing usable gives null', () => {
        expect(normalizeTranscript({ segments: [[1, ''], ['x', 'a'], [null, 'b'], 'junk'] })).toBeNull();
        expect(normalizeTranscript(null)).toBeNull();
        expect(normalizeTranscript({})).toBeNull();
        expect(normalizeTranscript([[3, 'bare array works']]).segments).toEqual([{ s: 3, t: 'bare array works' }]);
    });
});

describe('translated tracks (alt)', () => {
    const hindi = { lang: 'hi-orig', source: 'captions', segments: [[0, 'नमस्कार'], [60, 'शासन देवता की पूजा भगवान के समान नहीं की जाती']],
        alt: [
            { lang: 'en', source: 'translated', segments: [[0, 'greetings'], [60, 'shasana devata is not worshipped as equal to the lord']] },
            { lang: 'kn', source: 'translated', segments: [[60, 'ಶಾಸನ ದೇವತೆಯನ್ನು ಭಗವಂತನ ಸಮಾನವಾಗಿ ಪೂಜಿಸುವುದಿಲ್ಲ']] },
            { lang: 'ta', source: 'translated', segments: [] },
        ] };

    test('normalizeTranscript keeps the main track and each non-empty alt track', () => {
        const t = normalizeTranscript(hindi);
        expect(t.lang).toBe('hi-orig');
        expect(t.alt.map(a => a.lang)).toEqual(['en', 'kn']);          // the empty one is dropped
        expect(t.alt[0].source).toBe('translated');
        expect(normalizeTranscript({ segments: [[1, 'x']] }).alt).toEqual([]);
    });

    test('an English question finds a Hindi-spoken line through its English translation, at that line\u2019s time', () => {
        const idx = createVideoIndex({ data: fixture(), transcripts: { [V3]: hindi } });
        const [m] = findMoments(idx, 'is shasana devata worshipped as equal to the lord');
        expect(m.videoId).toBe(V3);
        expect(m.kind).toBe('transcript');
        expect(m.source).toBe('translated');
        expect(m.start).toBeGreaterThanOrEqual(56);
        expect(m.start).toBeLessThanOrEqual(60);
    });

    test('a Kannada question finds it through the Kannada translation', () => {
        const idx = createVideoIndex({ data: fixture(), transcripts: { [V3]: hindi } });
        const [m] = findMoments(idx, 'ಶಾಸನ ದೇವತೆಯನ್ನು ಭಗವಂತನ ಸಮಾನವಾಗಿ ಪೂಜಿಸುವುದಿಲ್ಲ');
        expect(m).toMatchObject({ videoId: V3, kind: 'transcript', source: 'translated' });
    });

    test('a Hindi question finds the spoken (main) track, whose source is the captions', () => {
        const idx = createVideoIndex({ data: fixture(), transcripts: { [V3]: hindi } });
        const [m] = findMoments(idx, 'शासन देवता की पूजा');
        expect(m).toMatchObject({ videoId: V3, kind: 'transcript', source: 'captions' });
        expect(m.snippet).toContain('शासन देवता');
    });

    test('a video still gets one result even though several of its tracks match', () => {
        const idx = createVideoIndex({ data: fixture(), transcripts: { [V3]: hindi } });
        const ids = findMoments(idx, 'shasana devata worshipped lord', { k: 5 }).map(m => m.videoId);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('windowSegments', () => {
    const cue = (s, t = `cue${s}`) => ({ s, t });

    test('groups about half a minute together, sharing one cue with the next window', () => {
        const segs = [0, 10, 20, 30, 40, 50, 60].map(s => cue(s));
        const w = windowSegments(segs);
        expect(w[0]).toEqual({ start: 0, text: 'cue0 cue10 cue20 cue30' });
        expect(w[1].text.startsWith('cue30')).toBe(true);        // overlap: nothing is cut in half
        expect(w[w.length - 1].text.endsWith('cue60')).toBe(true);
    });

    test('every cue lands in some window, and it always finishes', () => {
        const segs = Array.from({ length: 200 }, (_, i) => cue(i * 7));
        const text = windowSegments(segs).map(w => w.text).join(' ');
        segs.forEach(c => expect(text).toContain(c.t));
    });

    test('a single huge cue, a single cue and no cues all work', () => {
        expect(windowSegments([cue(0, 'x'.repeat(2000))])).toHaveLength(1);
        expect(windowSegments([cue(4)])).toEqual([{ start: 4, text: 'cue4' }]);
        expect(windowSegments([])).toEqual([]);
    });

    test('long cues are cut by size as well as by time', () => {
        const segs = [cue(0, 'a'.repeat(300)), cue(1, 'b'.repeat(300)), cue(2, 'c'.repeat(300))];
        expect(windowSegments(segs, { maxChars: 500 }).length).toBeGreaterThan(1);
    });
});

describe('loadTranscripts', () => {
    const ok = body => ({ ok: true, json: async () => body });

    test('reads the index, then each listed transcript', async () => {
        const fetchFn = jest.fn(async url => {
            if (url.endsWith('index.json')) return ok({ [V1]: {}, [V2]: {} });
            if (url.endsWith(`${V1}.json`)) return ok(transcript([[0, 'hello']]));
            if (url.endsWith(`${V2}.json`)) return ok(transcript([[5, 'world']], { source: 'whisper' }));
            throw new Error('unexpected ' + url);
        });
        const out = await loadTranscripts({ fetchFn });
        expect(Object.keys(out).sort()).toEqual([V1, V2]);
        expect(out[V2].source).toBe('whisper');
        expect(fetchFn).toHaveBeenCalledWith('assets/transcripts/index.json');
    });

    test('no index (404), no fetch function, or a network error all mean "no transcripts", never a failure', async () => {
        expect(await loadTranscripts({ fetchFn: async () => ({ ok: false }) })).toEqual({});
        expect(await loadTranscripts({ fetchFn: async () => { throw new Error('offline'); } })).toEqual({});
        expect(await loadTranscripts({ fetchFn: null })).toEqual({});
    });

    test('a missing, broken or empty transcript is skipped; the others still load', async () => {
        const fetchFn = async url => {
            if (url.endsWith('index.json')) return ok({ [V1]: {}, [V2]: {}, [V3]: {}, 'not-an-id': {} });
            if (url.endsWith(`${V1}.json`)) return { ok: false };
            if (url.endsWith(`${V2}.json`)) return { ok: true, json: async () => { throw new Error('bad json'); } };
            if (url.endsWith(`${V3}.json`)) return ok(transcript([[1, 'fine']]));
            throw new Error('asked for something that is not a video id: ' + url);
        };
        expect(Object.keys(await loadTranscripts({ fetchFn }))).toEqual([V3]);
    });
});

describe('findMoments', () => {
    const transcripts = {
        [V1]: transcript([
            [0, 'welcome to this talk'], [20, 'today we speak about daily worship'], [40, 'first the panchamrita abhisheka is prepared'],
            [60, 'milk curd ghee honey and sugar are used'], [80, 'then the water is poured slowly'],
            [120, 'finally the aarti is performed'],
        ]),
    };
    const index = createVideoIndex({ data: fixture(), transcripts });

    test('reports how many videos there are and how many have a transcript', () => {
        expect(index.stats).toEqual({ videos: 3, withTranscript: 1 });
    });

    test('a word spoken in a transcript finds the moment, starting a couple of seconds early', () => {
        const [m] = findMoments(index, 'when is the aarti performed');
        expect(m.videoId).toBe(V1);
        expect(m.kind).toBe('transcript');
        expect(m.start).toBeGreaterThanOrEqual(100);
        expect(m.start).toBeLessThanOrEqual(118);       // the window holding the aarti line, minus the lead-in
        expect(m.snippet).toContain('aarti');
        expect(m.label).toBe('A-1.1');
        expect(m.source).toBe('captions');
    });

    test('a hand-written mark beats the owner\u2019s start and is shown as the author wrote it', () => {
        const [m] = findMoments(index, 'padmavati devi worship');
        expect(m.videoId).toBe(V2);
        expect(m.kind).toBe('mark');
        expect(m.start).toBe(754);
        expect(m.snippet).toBe('Padmavati devi worship explained');
    });

    test('a video with no transcript and no mark is still found through the passage it is attached to', () => {
        const [m] = findMoments(index, 'aahara daana food');
        expect(m.videoId).toBe(V3);
        expect(m.kind).toBe('owner');
        expect(m.start).toBe(0);
        expect(m.snippet).toBe('');
    });

    test('a ?t= in the book\u2019s own link is where an owner-only result starts', () => {
        const noTranscript = createVideoIndex({ data: fixture() });
        const [m] = findMoments(noTranscript, 'abhisheka with water and milk');
        expect(m).toMatchObject({ videoId: V1, kind: 'owner', start: 90 });
    });

    test('spelling variants of a transliterated word still find it (same folding as the passage search)', () => {
        const [m] = findMoments(index, 'panchaamrita abhishek');
        expect(m.videoId).toBe(V1);
    });

    test('Kannada words match through the passage text of the video\u2019s block', () => {
        const [m] = findMoments(index, 'ಅಭಿಷೇಕ ನೀರಿನಿಂದ');
        expect(m.videoId).toBe(V1);
    });

    test('a video attached to a passage the answer shows is offered even when no word matched, after the real matches', () => {
        const moments = findMoments(index, 'aarti', { passages: [{ id: 'ba3' }] });
        expect(moments.map(m => m.videoId)).toEqual([V1, V3]);
        expect(moments[1]).toMatchObject({ kind: 'owner', label: 'A-3.1' });
    });

    test('being attached to a shown passage ranks a video higher than the same words elsewhere', () => {
        // "abhisheka" is in V1's block and tags; V3 only appears because the answer shows its passage
        const plain = findMoments(index, 'abhisheka water')[0];
        const boosted = findMoments(index, 'abhisheka water', { passages: [{ id: 'ba1' }] })[0];
        expect(boosted.score).toBeGreaterThan(plain.score);
    });

    test('a weak match next to a strong one (a common word in a long line) is not offered', () => {
        const data = [
            { id: 'a1', type: 'answer', num: 1, blocks: [{ id: 'ba1', num: 1, type: 'paragraph', content: { kn: [], en: ['Abhisheka is done with water and milk.'] }, tags: ['Abhisheka'], videos: [{ url: `https://youtu.be/${V1}`, youtubeId: V1 }] }] },
            { id: 'a3', type: 'answer', num: 3, blocks: [{ id: 'ba3', num: 1, type: 'paragraph', content: { kn: [], en: ['Something unrelated.'] }, tags: [], videos: [{ url: `https://youtu.be/${V3}`, youtubeId: V3 }] }] },
        ];
        const weak = { [V3]: transcript([[0, 'a long talk about many different things including a little water somewhere in the middle of a very long sentence about other topics entirely and more words to dilute']]) };
        const idx = createVideoIndex({ data, transcripts: weak });
        expect(findMoments(idx, 'abhisheka water milk', { k: 5, minScore: 0.1 }).map(m => m.videoId)).toEqual([V1]);
    });

    test('nothing matches, nothing is offered', () => {
        expect(findMoments(index, 'zzzz qqqq')).toEqual([]);
        expect(findMoments(index, '')).toEqual([]);
        expect(findMoments(createVideoIndex({ data: [] }), 'abhisheka')).toEqual([]);
        expect(findMoments(null, 'abhisheka')).toEqual([]);
    });

    test('at most k results, one per video, best first', () => {
        const moments = findMoments(index, 'abhisheka water milk food worship', { k: 2 });
        expect(moments.length).toBeLessThanOrEqual(2);
        expect(new Set(moments.map(m => m.videoId)).size).toBe(moments.length);
        for (let i = 1; i < moments.length; i++) expect(moments[i - 1].score).toBeGreaterThanOrEqual(moments[i].score);
    });

    test('a long transcript cannot crowd every other video out of the results', () => {
        const long = transcript(Array.from({ length: 600 }, (_, i) => [i * 5, `abhisheka line number ${i}`]));
        const idx = createVideoIndex({ data: fixture(), transcripts: { [V1]: long } });
        const moments = findMoments(idx, 'abhisheka', { k: 3, passages: [{ id: 'ba2' }] });
        expect(moments.map(m => m.videoId)).toContain(V2);
    });
});
