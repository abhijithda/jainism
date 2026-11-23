// The "Watch" rows under an answer: drawn from the video search, opening the player at the moment.

const mockEngine = { id: 'cloud', generate: jest.fn(), prepare: jest.fn(async () => {}), available: () => ({ ok: true }) };
jest.mock('./engines/index.js', () => ({ getEngine: () => mockEngine }));

const { initAi, renderMoments } = require('./ai-panel');
const { saveSettings } = require('../core/settings');

const V1 = 'AAAAAAAAAAA';
const data = [
    { id: 'q1', type: 'question', num: 1, blocks: [{ id: 'bq1', num: 1, type: 'paragraph', content: { kn: [], en: ['How is abhisheka done?'] }, tags: ['Abhisheka'] }] },
    {
        id: 'a1', type: 'answer', references: ['q1'], blocks: [{
            id: 'ba1', num: 1, type: 'paragraph', content: { kn: [], en: ['Abhisheka is done with water and milk.'] }, tags: ['Abhisheka'],
            videos: [{ url: `https://www.youtube.com/watch?v=${V1}`, youtubeId: V1, marks: [{ t: '3:05', label: 'Milk abhisheka step by step' }] }],
        }],
    },
    { id: 'a2', type: 'answer', num: 2, blocks: [{ id: 'ba2', num: 1, type: 'paragraph', content: { kn: [], en: ['Giving food is aahara daana.'] }, tags: ['Aahara Daana'] }] },
];

const flush = () => new Promise(r => setTimeout(r, 0));
async function ask(question) {
    document.getElementById('ai-input').value = question;
    document.getElementById('ai-send').click();
    for (let i = 0; i < 30 && document.getElementById('ai-send').disabled; i++) await flush();
}
const last = () => [...document.querySelectorAll('.ai-msg--assistant')].pop();

let onWatch;
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    saveSettings({ aiEngine: 'cloud' });
    document.body.innerHTML = '<button id="ai-btn"></button><select id="ai-engine-select"><option value="cloud"></option></select><span id="ai-engine-note"></span>';
    mockEngine.generate.mockReset();
    onWatch = jest.fn();
    initAi({ data, onCite: jest.fn(), onWatch });
});

describe('Watch under an answer', () => {
    test('a grounded answer about something with a video gets a Watch button that opens it at the moment', async () => {
        mockEngine.generate.mockResolvedValue('Abhisheka is done with water and milk [A-1.1].');
        await ask('how is abhisheka done with milk');
        const btn = last().querySelector('.ai-videos button.ai-watch');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toBe('\u25B6 3:05');
        expect(last().querySelector('.ai-moment-snippet').textContent).toContain('Milk abhisheka step by step');
        btn.click();
        expect(onWatch).toHaveBeenCalledWith({ videoId: V1, start: 185, label: 'A-1.1' });
    });

    test('an answer whose passages have no video gets no Watch section', async () => {
        mockEngine.generate.mockResolvedValue('Giving food is aahara daana [A-2.1].');
        await ask('what is aahara daana');
        expect(last().querySelector('.ai-videos')).toBeNull();
    });

    test('a question the book does not cover offers no video', async () => {
        await ask('qqqq zzzz');
        expect(last().querySelector('.ai-videos')).toBeNull();
        expect(mockEngine.generate).not.toHaveBeenCalled();
    });

    test('even the passages-only fallback (uncited answer) can offer the video that goes with them', async () => {
        mockEngine.generate.mockResolvedValue('Something with no citation at all.');
        await ask('how is abhisheka done with milk');
        expect(last().textContent).toMatch(/couldn.t write a reliable summary/);
        expect(last().querySelector('.ai-videos button.ai-watch')).not.toBeNull();
    });

    test('the Watch rows survive a reload of the tab, with working buttons', async () => {
        mockEngine.generate.mockResolvedValue('Abhisheka is done with water and milk [A-1.1].');
        await ask('how is abhisheka done with milk');
        document.body.innerHTML = '<button id="ai-btn"></button><select id="ai-engine-select"><option value="cloud"></option></select><span id="ai-engine-note"></span>';
        const again = jest.fn();
        initAi({ data, onCite: jest.fn(), onWatch: again });
        const btn = document.querySelector('.ai-videos button.ai-watch');
        expect(btn).not.toBeNull();
        btn.click();
        expect(again).toHaveBeenCalledWith(expect.objectContaining({ videoId: V1, start: 185 }));
    });

    test('a failure inside the video search never costs the reader their answer', async () => {
        mockEngine.generate.mockResolvedValue('Abhisheka is done with water and milk [A-1.1].');
        const broken = JSON.parse(JSON.stringify(data));
        // A video entry that blows up when read (anything unexpected inside the video code path).
        broken[1].blocks[0].videos = [{ get url() { throw new Error('boom'); } }];
        initAi({ data: broken, onCite: jest.fn(), onWatch });
        await ask('how is abhisheka done with milk');
        expect(last().textContent).toContain('Abhisheka is done with water and milk');
        expect(last().classList.contains('ai-msg--error')).toBe(false);
        expect(last().querySelector('.ai-videos')).toBeNull();      // and it really did fail, quietly
    });
});

describe('renderMoments', () => {
    test('draws text only: a transcript line can never become markup', () => {
        const box = document.createElement('div');
        renderMoments(box, [{ videoId: V1, start: 70, kind: 'transcript', snippet: '<img src=x onerror=alert(1)>', source: 'captions', label: 'A-1.1' }], jest.fn());
        expect(box.querySelector('img')).toBeNull();
        expect(box.querySelector('.ai-moment-snippet').textContent).toContain('<img');
    });

    test('transcript lines say where they came from; the author\u2019s own marks do not need to', () => {
        const box = document.createElement('div');
        renderMoments(box, [
            { videoId: V1, start: 70, kind: 'transcript', snippet: 'x', source: 'captions', label: 'A-1.1' },
            { videoId: V1, start: 90, kind: 'transcript', snippet: 'y', source: 'whisper', label: 'A-1.1' },
            { videoId: V1, start: 120, kind: 'mark', snippet: 'z', label: 'A-1.1' },
        ], jest.fn());
        const notes = [...box.querySelectorAll('.ai-moment-note')].map(n => n.textContent);
        expect(notes).toHaveLength(2);
        expect(notes[0]).toMatch(/captions/i);
        expect(notes[1]).toMatch(/speech-to-text/i);
    });

    test('a machine-translated line says so', () => {
        const box = document.createElement('div');
        renderMoments(box, [{ videoId: V1, start: 70, kind: 'transcript', snippet: 'x', source: 'translated', label: 'A-1.1' }], jest.fn());
        expect(box.querySelector('.ai-moment-note').textContent).toMatch(/machine-translated/i);
        expect(box.querySelector('.ai-moment-note').textContent).toMatch(/YouTube/);
        expect(box.querySelector('.ai-moment-note').textContent).not.toMatch(/Gemini/);
    });

    test('a line translated with Gemini says Gemini, not YouTube, and still says to check by listening', () => {
        const box = document.createElement('div');
        renderMoments(box, [{ videoId: V1, start: 70, kind: 'transcript', snippet: 'x', source: 'translated', via: 'gemini', label: 'A-1.1' }], jest.fn());
        const note = box.querySelector('.ai-moment-note').textContent;
        expect(note).toMatch(/Machine-translated by Gemini/);
        expect(note).toMatch(/rough or wrong/);
        expect(note).toMatch(/listening/);
        expect(note).not.toMatch(/YouTube.s captions/);
    });

    test('an unknown way of translating falls back to the general note', () => {
        const box = document.createElement('div');
        renderMoments(box, [{ videoId: V1, start: 70, kind: 'transcript', snippet: 'x', source: 'translated', via: 'something-new', label: 'A-1.1' }], jest.fn());
        expect(box.querySelector('.ai-moment-note').textContent).toMatch(/machine-translated/i);
    });

    test('a video offered only because it is attached to the passage says so, and plays from the start', () => {
        const box = document.createElement('div');
        const onWatch = jest.fn();
        renderMoments(box, [{ videoId: V1, start: 0, kind: 'owner', snippet: '', label: 'A-1.1' }], onWatch);
        expect(box.querySelector('.ai-watch').textContent).toBe('\u25B6 Watch');
        expect(box.querySelector('.ai-moment-label').textContent).toBe('Video with A-1.1');
        expect(box.querySelector('.ai-moment-snippet')).toBeNull();
        box.querySelector('.ai-watch').click();
        expect(onWatch).toHaveBeenCalledWith({ videoId: V1, start: 0, label: 'A-1.1' });
    });

    test('nothing to show draws nothing; a missing onWatch does not throw', () => {
        const box = document.createElement('div');
        renderMoments(box, [], jest.fn());
        renderMoments(box, undefined, jest.fn());
        expect(box.children).toHaveLength(0);
        renderMoments(box, [{ videoId: V1, start: 5, kind: 'mark', snippet: 's', label: 'A-1.1' }], undefined);
        expect(() => box.querySelector('.ai-watch').click()).not.toThrow();
    });
});
