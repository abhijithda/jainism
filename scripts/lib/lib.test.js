// Tests for scripts/lib/book.js, youtube.js and gemini.js.
const fs = require('fs');
const path = require('path');
const { buildBlockIndex, formatIdForDisplay } = require('../../src/core/blocks.js');
const B = require('./book');
const Y = require('./youtube');
const { createGemini, parseJsonAnswer } = require('./gemini');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'data.json'), 'utf8'));

describe('book numbering', () => {
    test('labels are the same as the app shows, for every block of the real book', () => {
        const idx = buildBlockIndex(data);
        const mine = B.allBlocks(data);
        expect(mine.length).toBeGreaterThan(100);
        for (const { block, label } of mine) expect(label).toBe(formatIdForDisplay(idx.blockById[block.id]));
    });
    test('parsePlace understands ids, item labels, block labels and numbers', () => {
        expect(B.parsePlace('A-11.2')).toEqual({ kind: 'block', letter: 'A', num: 11, sub: 2 });
        expect(B.parsePlace('q-3')).toEqual({ kind: 'item', letter: 'Q', num: 3 });
        expect(B.parsePlace('12')).toEqual({ kind: 'number', num: 12 });
        expect(B.parsePlace('z5xxer')).toEqual({ kind: 'id', id: 'z5xxer' });
        expect(B.parsePlace('  ')).toBeNull();
    });
    test('insertIndex: end, id, block label, item label, number, and clear errors', () => {
        expect(B.insertIndex(data, '')).toBe(data.length);
        expect(B.insertIndex(data, 'end')).toBe(data.length);
        const i = data.findIndex((x) => x.id === 'z5xxer');
        expect(B.insertIndex(data, 'z5xxer')).toBe(i + 1);
        expect(B.insertIndex(data, data[i].blocks[0].id)).toBe(i + 1);
        const hit = B.findBlock(data, 'A-3.1');
        expect(B.insertIndex(data, 'A-3.1')).toBe(hit.position + 1);
        const qa = data.map((x, k) => [x, k]).filter(([x]) => B.itemNumber(x, B.byId(data)) === 11);
        expect(B.insertIndex(data, 'A-11')).toBe(qa.filter(([x]) => x.type === 'answer').pop()[1] + 1);
        expect(B.insertIndex(data, 'Q-11')).toBe(qa.filter(([x]) => x.type === 'question').pop()[1] + 1);
        expect(B.insertIndex(data, '11')).toBe(qa.pop()[1] + 1);
        expect(() => B.insertIndex(data, 'A-999')).toThrow(/cannot find A-999/);
        expect(() => B.insertIndex(data, 'nosuch')).toThrow(/cannot find/);
    });
    test('maxNum is the highest item num', () => {
        expect(B.maxNum(data)).toBe(Math.max(...data.filter((x) => Number.isInteger(x.num)).map((x) => x.num)));
    });
});

describe('YouTube links', () => {
    test('ids and start times from every common form', () => {
        expect(Y.parseYouTube('https://youtu.be/-6Xivr3u_JI?t=307')).toEqual({ id: '-6Xivr3u_JI', start: 307 });
        expect(Y.parseYouTube('https://www.youtube.com/watch?v=J_noWizvxsw&t=1m5s')).toEqual({ id: 'J_noWizvxsw', start: 65 });
        expect(Y.parseYouTube('https://www.youtube.com/shorts/5iPr8mqvu7E')).toEqual({ id: '5iPr8mqvu7E', start: null });
        expect(Y.parseYouTube('https://www.youtube.com/live/AbCdEfGhIjK?si=x')).toEqual({ id: 'AbCdEfGhIjK', start: null });
        expect(Y.parseYouTube('https://forms.gle/abc')).toBeNull();
        expect(Y.parseYouTube('https://www.youtube.com/channel/UC123')).toBeNull();
    });
    test('offsets', () => {
        expect(['90', '1:30', '1m30s', '0:01:30'].map(Y.parseOffset)).toEqual([90, 90, 90, 90]);
        expect(Y.parseOffset('1h2m3s')).toBe(3723);
        expect(Y.parseOffset('soon')).toBeNull();
    });
    test('links in running text lose the sentence punctuation', () => {
        expect(Y.findLinks('see https://youtu.be/aaaaaaaaaaa?t=5, then (https://youtu.be/bbbbbbbbbbb).').map((l) => l.url))
            .toEqual(['https://youtu.be/aaaaaaaaaaa?t=5', 'https://youtu.be/bbbbbbbbbbb']);
    });
    test('momentUrl', () => {
        expect(Y.momentUrl('aaaaaaaaaaa', 0)).toBe('https://youtu.be/aaaaaaaaaaa');
        expect(Y.momentUrl('aaaaaaaaaaa', 750.9)).toBe('https://youtu.be/aaaaaaaaaaa?t=750');
    });
});

describe('the Gemini client', () => {
    const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
    test('sends the key in a header (never in the URL), the parts before the prompt, and asks for JSON', async () => {
        const fetchImpl = jest.fn(async () => ok('{"a":1}'));
        const ai = createGemini({ apiKey: 'SECRET', model: 'm-1', fetchImpl });
        const out = await ai.json({ system: 'sys', prompt: 'hello', parts: [{ fileData: { fileUri: 'u' } }] });
        expect(out).toEqual({ a: 1 });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent');
        expect(url).not.toMatch(/SECRET/);
        expect(init.headers['x-goog-api-key']).toBe('SECRET');
        const body = JSON.parse(init.body);
        expect(body.contents[0].parts).toEqual([{ fileData: { fileUri: 'u' } }, { text: 'hello' }]);
        expect(body.generationConfig.responseMimeType).toBe('application/json');
        expect(body.systemInstruction.parts[0].text).toBe('sys');
    });
    test('fenced JSON and JSON with chatter around it are read', () => {
        expect(parseJsonAnswer('```json\n{"a":[1]}\n```')).toEqual({ a: [1] });
        expect(parseJsonAnswer('Sure! {"a":2} Hope that helps')).toEqual({ a: 2 });
        expect(() => parseJsonAnswer('no json here')).toThrow(/did not return JSON/);
    });
    test('busy answers (429/5xx) are retried with a pause, then succeed', async () => {
        const answers = [{ ok: false, status: 429, json: async () => ({}) }, { ok: false, status: 503, json: async () => ({}) }, ok('[1]')];
        const sleep = jest.fn(async () => {});
        const ai = createGemini({ apiKey: 'k', fetchImpl: async () => answers.shift(), sleep });
        expect(await ai.json({ prompt: 'x' })).toEqual([1]);
        expect(sleep).toHaveBeenCalledTimes(2);
    });
    test('a 400 is not retried and the message names the model, never the key', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'model not found' } }) }));
        const ai = createGemini({ apiKey: 'SECRET', model: 'old-model', fetchImpl });
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/400: model not found \(model: old-model\)/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        await ai.json({ prompt: 'x' }).catch((e) => expect(e.message).not.toMatch(/SECRET/));
    });
    test('no key: unavailable, and a clear error if called', async () => {
        const saved = process.env.GEMINI_API_KEY;
        delete process.env.GEMINI_API_KEY;
        const ai = createGemini({});
        expect(ai.available).toBe(false);
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/GEMINI_API_KEY/);
        if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    });
    test('an empty answer says why', async () => {
        const ai = createGemini({ apiKey: 'k', retries: 0, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }) });
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/SAFETY/);
    });
});
