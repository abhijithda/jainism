// Tests for scripts/lib/book.js, youtube.js and gemini.js.
const fs = require('fs');
const path = require('path');
const { buildBlockIndex, formatIdForDisplay } = require('../../src/core/blocks.js');
const B = require('./book');
const Y = require('./youtube');
const { createGemini, parseJsonAnswer, thinkingConfigFrom } = require('./gemini');

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

describe('the Gemini client: usage and thinking', () => {
    const withUsage = (text, usage) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage }) });
    const sent = (fetchImpl, n = 0) => JSON.parse(fetchImpl.mock.calls[n][1].body).generationConfig;

    beforeEach(() => { delete process.env.GEMINI_THINKING_LEVEL; delete process.env.GEMINI_THINKING_BUDGET; });

    test('every call logs its tokens (thinking apart) and the totals add up', async () => {
        const lines = [];
        const answers = [
            withUsage('{"a":1}', { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 2900, totalTokenCount: 4400 }),
            withUsage('{"b":2}', { promptTokenCount: 800, candidatesTokenCount: 100, thoughtsTokenCount: 3100, totalTokenCount: 4000 }),
        ];
        const ai = createGemini({ apiKey: 'k', model: 'm-1', fetchImpl: async () => answers.shift(), log: (l) => lines.push(l) });
        await ai.json({ prompt: 'x' });
        await ai.json({ prompt: 'y' });
        expect(lines[0]).toMatch(/call 1: in 1200, out 300, thinking 2900, total 4400 tokens/);
        expect(ai.usage()).toMatchObject({ calls: 2, prompt: 2000, output: 400, thinking: 6000, total: 8400 });
        ai.printUsage();
        expect(lines[lines.length - 1]).toMatch(/m-1: 2 call\(s\), in 2000, out 400, thinking 6000, total 8400 tokens/);
        expect(lines[lines.length - 1]).toMatch(/model default/);
    });

    test('an answer without usage numbers is still logged and counted', async () => {
        const lines = [];
        const ai = createGemini({ apiKey: 'k', fetchImpl: async () => withUsage('{"a":1}', undefined), log: (l) => lines.push(l) });
        await ai.json({ prompt: 'x' });
        expect(lines[0]).toMatch(/no usage numbers/);
        expect(ai.usage().calls).toBe(1);
    });

    test('printUsage says nothing when no call was made', () => {
        const lines = [];
        createGemini({ apiKey: 'k', log: (l) => lines.push(l) }).printUsage();
        expect(lines).toEqual([]);
    });

    test('by default no thinking setting is sent', async () => {
        const fetchImpl = jest.fn(async () => withUsage('{}', {}));
        await createGemini({ apiKey: 'k', fetchImpl, log: () => {} }).json({ prompt: 'x' });
        expect(sent(fetchImpl).thinkingConfig).toBeUndefined();
    });

    test('a thinking level (option or GEMINI_THINKING_LEVEL) is sent as thinkingLevel', async () => {
        const fetchImpl = jest.fn(async () => withUsage('{}', {}));
        await createGemini({ apiKey: 'k', fetchImpl, thinkingLevel: 'low', log: () => {} }).json({ prompt: 'x' });
        expect(sent(fetchImpl).thinkingConfig).toEqual({ thinkingLevel: 'low' });

        process.env.GEMINI_THINKING_LEVEL = ' Minimal ';
        await createGemini({ apiKey: 'k', fetchImpl, log: () => {} }).json({ prompt: 'x' });
        expect(sent(fetchImpl, 1).thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    });

    test('a level wins over a budget: never both (the API refuses that)', () => {
        expect(thinkingConfigFrom('low', 1024)).toEqual({ thinkingLevel: 'low' });
        expect(thinkingConfigFrom('', '1024')).toEqual({ thinkingBudget: 1024 });
        expect(thinkingConfigFrom('', '0')).toEqual({ thinkingBudget: 0 });
    });

    test('empty or invalid values send nothing', () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(thinkingConfigFrom('', '')).toBeNull();
        expect(thinkingConfigFrom(undefined, undefined)).toBeNull();
        expect(thinkingConfigFrom('extreme', '')).toBeNull();
        expect(thinkingConfigFrom('', 'lots')).toBeNull();
        expect(err).toHaveBeenCalledTimes(2);
        err.mockRestore();
    });

    test('a model that refuses the thinking setting: the call is repeated once without it, and the run goes on without it', async () => {
        const lines = [];
        const answers = [
            { ok: false, status: 400, json: async () => ({ error: { message: 'Thinking level is not supported for this model' } }) },
            withUsage('{"a":1}', { totalTokenCount: 10 }),
            withUsage('{"b":2}', { totalTokenCount: 10 }),
        ];
        const fetchImpl = jest.fn(async () => answers.shift());
        const ai = createGemini({ apiKey: 'k', fetchImpl, thinkingLevel: 'low', sleep: async () => {}, log: (l) => lines.push(l) });
        expect(await ai.json({ prompt: 'x' })).toEqual({ a: 1 });
        expect(sent(fetchImpl, 0).thinkingConfig).toEqual({ thinkingLevel: 'low' });
        expect(sent(fetchImpl, 1).thinkingConfig).toBeUndefined();
        expect(lines.some((l) => /refused the thinking setting/.test(l))).toBe(true);
        expect(await ai.json({ prompt: 'y' })).toEqual({ b: 2 });
        expect(sent(fetchImpl, 2).thinkingConfig).toBeUndefined();
    });

    test('a 400 that is not about thinking still fails at once', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'model not found' } }) }));
        const ai = createGemini({ apiKey: 'k', model: 'x', fetchImpl, thinkingLevel: 'low', log: () => {} });
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/model not found/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
