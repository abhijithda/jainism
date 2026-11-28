// Tests for scripts/lib/book.js, youtube.js and gemini.js.
const fs = require('fs');
const path = require('path');
const { buildBlockIndex, formatIdForDisplay } = require('../../src/core/blocks.js');
const B = require('./book');
const Y = require('./youtube');
const { createGemini, parseJsonAnswer, thinkingConfigFrom, modelsFrom } = require('./gemini');

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
    test('an answer that is not valid JSON carries the whole answer as error.raw, so a caller can show where it broke', async () => {
        const broken = '{"cues":[{"i":1,"en":"he said "hello" to them"}]}';
        const ai = createGemini({ apiKey: 'k', retries: 0, log: () => {}, fetchImpl: async () => ok(broken) });
        const err = await ai.json({ prompt: 'x' }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.raw).toBe(broken);
        expect(err.unavailable).toBeUndefined();
    });
    test('reset() lifts the "unavailable" flag but keeps what the client has learned (the model that answered, the usage totals)', async () => {
        const asked = [];
        let m1Busy = true;
        const fetchImpl = async (url) => {
            const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
            asked.push(model);
            if (model === 'm1' && m1Busy) return { ok: false, status: 503, json: async () => ({}) };
            return ok('{"a":1}');
        };
        const ai = createGemini({ apiKey: 'k', models: ['m1', 'm2'], retries: 0, fetchImpl, sleep: async () => {}, log: () => {} });
        await ai.json({ prompt: 'x' });                         // m1 busy, m2 answers: later calls start with m2
        expect(asked).toEqual(['m1', 'm2']);
        asked.length = 0;
        m1Busy = false;
        await ai.json({ prompt: 'x' });
        expect(asked).toEqual(['m1', 'm2'].slice(1));            // straight to m2, no wasted call on m1
        expect(ai.usage().calls).toBe(2);

        const down = createGemini({ apiKey: 'k', retries: 0, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), sleep: async () => {}, log: () => {} });
        const e1 = await down.json({ prompt: 'x' }).catch((e) => e);
        expect(e1.unavailable).toBe(true);
        const e2 = await down.json({ prompt: 'x' }).catch((e) => e);
        expect(e2.message).toMatch(/not asked again/);
        down.reset();
        const e3 = await down.json({ prompt: 'x' }).catch((e) => e);
        expect(e3.message).not.toMatch(/not asked again/);        // a real request was made again (and failed again)
        expect(e3.unavailable).toBe(true);
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
        expect(lines[0]).toMatch(/call 1 \(m-1\): in 1200, out 300, thinking 2900, total 4400 tokens/);
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

    test('a model with no "minimal" level gets "low" instead (not the model\u2019s own default thinking), and only that model', async () => {
        const lines = [];
        const refuse = { ok: false, status: 400, json: async () => ({ error: { message: 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.' } }) };
        const answers = [refuse, withUsage('{"a":1}', { totalTokenCount: 10 }), withUsage('{"b":2}', { totalTokenCount: 10 })];
        const fetchImpl = jest.fn(async () => answers.shift());
        const ai = createGemini({ apiKey: 'k', fetchImpl, thinkingLevel: 'minimal', sleep: async () => {}, log: (l) => lines.push(l) });
        expect(await ai.json({ prompt: 'x' })).toEqual({ a: 1 });
        expect(sent(fetchImpl, 0).thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
        expect(sent(fetchImpl, 1).thinkingConfig).toEqual({ thinkingLevel: 'low' });
        expect(lines.some((l) => /refused thinking level minimal .*using low for this model/.test(l))).toBe(true);
        expect(await ai.json({ prompt: 'y' })).toEqual({ b: 2 });
        expect(sent(fetchImpl, 2).thinkingConfig).toEqual({ thinkingLevel: 'low' });     // remembered: no second refused call
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    test('if "low" is refused too, the model gets no thinking setting at all; a different model still gets "minimal"', async () => {
        const lines = [];
        const refuse = { ok: false, status: 400, json: async () => ({ error: { message: 'Thinking level is not supported for this model' } }) };
        const calls = [];
        const fetchImpl = jest.fn(async (url, init) => {
            const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
            const cfg = JSON.parse(init.body).generationConfig.thinkingConfig;
            calls.push([model, cfg && cfg.thinkingLevel]);
            if (model === 'm1' && cfg) return refuse;
            if (model === 'm1') return { ok: false, status: 503, json: async () => ({}) };
            return withUsage('{"a":1}', { totalTokenCount: 10 });
        });
        const ai = createGemini({ apiKey: 'k', models: ['m1', 'm2'], retries: 0, fetchImpl, thinkingLevel: 'minimal', sleep: async () => {}, log: (l) => lines.push(l) });
        await ai.json({ prompt: 'x' });
        expect(calls).toEqual([['m1', 'minimal'], ['m1', 'low'], ['m1', undefined], ['m2', 'minimal']]);
        expect(lines.some((l) => /continuing without it for this model/.test(l))).toBe(true);
    });

    test('a level other than "minimal" that is refused is dropped at once (no step up)', async () => {
        const refuse = { ok: false, status: 400, json: async () => ({ error: { message: 'thinking level not supported' } }) };
        const answers = [refuse, withUsage('{"a":1}', { totalTokenCount: 1 })];
        const fetchImpl = jest.fn(async () => answers.shift());
        await createGemini({ apiKey: 'k', fetchImpl, thinkingLevel: 'medium', sleep: async () => {}, log: () => {} }).json({ prompt: 'x' });
        expect(sent(fetchImpl, 1).thinkingConfig).toBeUndefined();
    });

    test('a 400 that is not about thinking still fails at once', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'model not found' } }) }));
        const ai = createGemini({ apiKey: 'k', model: 'x', fetchImpl, thinkingLevel: 'low', log: () => {} });
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/model not found/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('the Gemini client: a busy server', () => {
    const busy = () => ({ ok: false, status: 503, json: async () => ({}) });
    const good = () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: {} }) });
    beforeEach(() => { delete process.env.GEMINI_MODELS; });

    test('after the retries are used up it stops asking: later calls fail at once, without a request', async () => {
        const lines = [];
        const fetchImpl = jest.fn(async () => busy());
        const ai = createGemini({ apiKey: 'k', fetchImpl, retries: 2, sleep: async () => {}, log: (l) => lines.push(l) });
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/503/);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        await expect(ai.json({ prompt: 'y' })).rejects.toThrow(/not asked again in this run.*503/);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(lines.some((l) => /no more Gemini calls in this run/.test(l))).toBe(true);
    });

    test('a busy answer that recovers within the retries still works, and the client keeps asking', async () => {
        const answers = [busy(), good(), good()];
        const fetchImpl = jest.fn(async () => answers.shift());
        const ai = createGemini({ apiKey: 'k', fetchImpl, retries: 2, sleep: async () => {}, log: () => {} });
        expect(await ai.json({ prompt: 'x' })).toEqual({ a: 1 });
        expect(await ai.json({ prompt: 'y' })).toEqual({ a: 1 });
    });

    test('an error that is not about load (a 400) does not stop later calls', async () => {
        const answers = [{ ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }) }, good()];
        const ai = createGemini({ apiKey: 'k', fetchImpl: async () => answers.shift(), retries: 2, sleep: async () => {}, log: () => {} });
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/bad request/);
        expect(await ai.json({ prompt: 'y' })).toEqual({ a: 1 });
    });

    test('GEMINI_MODELS: when the first model stays busy the next one is tried, and the rest of the run starts with it', async () => {
        const lines = [];
        const urls = [];
        const fetchImpl = jest.fn(async (url) => { urls.push(url); return url.includes('model-b') ? good() : busy(); });
        const ai = createGemini({ apiKey: 'k', models: 'model-a, model-b', fetchImpl, retries: 1, sleep: async () => {}, log: (l) => lines.push(l) });
        expect(ai.models).toEqual(['model-a', 'model-b']);
        expect(await ai.json({ prompt: 'x' })).toEqual({ a: 1 });
        expect(urls.filter((u) => u.includes('model-a'))).toHaveLength(2);
        expect(urls.filter((u) => u.includes('model-b'))).toHaveLength(1);
        expect(lines.some((l) => /model-a did not answer.*trying model-b/.test(l))).toBe(true);
        expect(ai.model).toBe('model-b');
        urls.length = 0;
        expect(await ai.json({ prompt: 'y' })).toEqual({ a: 1 });
        expect(urls).toHaveLength(1);                       // straight to model-b: no more waiting on the busy one
        expect(urls[0]).toContain('model-b');
    });

    test('a 429 (this model\'s quota) moves to the next model at once, without waiting on retries', async () => {
        const urls = [];
        const fetchImpl = jest.fn(async (url) => { urls.push(url); return url.includes('model-a') ? { ok: false, status: 429, json: async () => ({}) } : good(); });
        const ai = createGemini({ apiKey: 'k', models: ['model-a', 'model-b'], fetchImpl, retries: 3, sleep: async () => { throw new Error('should not wait'); }, log: () => {} });
        expect(await ai.json({ prompt: 'x' })).toEqual({ a: 1 });
        expect(urls).toHaveLength(2);
    });

    test('a model name the key cannot use (404) is skipped for the whole run', async () => {
        const urls = [];
        const fetchImpl = jest.fn(async (url) => { urls.push(url); return url.includes('no-such') ? { ok: false, status: 404, json: async () => ({}) } : good(); });
        const ai = createGemini({ apiKey: 'k', models: 'no-such-model,model-b', fetchImpl, sleep: async () => {}, log: () => {} });
        await ai.json({ prompt: 'x' });
        await ai.json({ prompt: 'y' });
        expect(urls.filter((u) => u.includes('no-such'))).toHaveLength(1);
        expect(urls.filter((u) => u.includes('model-b'))).toHaveLength(2);
    });

    test('with every model busy the run stops asking, and the error says Gemini is unavailable', async () => {
        const fetchImpl = jest.fn(async () => busy());
        const ai = createGemini({ apiKey: 'k', models: 'model-a,model-b', fetchImpl, retries: 1, sleep: async () => {}, log: () => {} });
        const err = await ai.json({ prompt: 'x' }).catch((e) => e);
        expect(err.unavailable).toBe(true);
        expect(err.message).toMatch(/503/);
        expect(fetchImpl).toHaveBeenCalledTimes(4);         // model-a: 1 try + 1 retry; model-b: 1 try + 1 retry
        const again = await ai.json({ prompt: 'y' }).catch((e) => e);
        expect(again.unavailable).toBe(true);
        expect(again.message).toMatch(/not asked again/);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    test('an error that is not about load is not marked unavailable', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }) }));
        const err = await createGemini({ apiKey: 'k', fetchImpl, log: () => {} }).json({ prompt: 'x' }).catch((e) => e);
        expect(err.unavailable).toBeUndefined();
    });

    test('GEMINI_MODELS and GEMINI_MODEL: the list wins, the single name still works, blanks and repeats go', () => {
        expect(modelsFrom('a, b ,,a', 'x')).toEqual(['a', 'b']);
        expect(modelsFrom(undefined, 'x')).toEqual(['x']);
        expect(modelsFrom('', '')).toEqual([expect.stringMatching(/^gemini/)]);
        process.env.GEMINI_MODELS = 'm1,m2';
        expect(createGemini({ apiKey: 'k', log: () => {} }).models).toEqual(['m1', 'm2']);
        delete process.env.GEMINI_MODELS;
    });
});

describe('the Gemini client: thinking setting with several models', () => {
    const good = () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: {} }) });
    const refuse = () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Thinking level is not supported for this model' } }) });
    const busy = () => ({ ok: false, status: 503, json: async () => ({}) });
    const cfg = (call) => JSON.parse(call[1].body).generationConfig.thinkingConfig;
    beforeEach(() => { delete process.env.GEMINI_MODELS; delete process.env.GEMINI_THINKING_LEVEL; });

    test('a model that refuses the setting loses it; the next model in the list still gets it', async () => {
        const lines = [];
        const calls = [];
        const answers = { 'model-a': [refuse(), busy(), busy()], 'model-b': [good()] };
        const fetchImpl = jest.fn(async (url, init) => { calls.push([url, init]); const m = url.includes('model-a') ? 'model-a' : 'model-b'; return answers[m].shift(); });
        const ai = createGemini({ apiKey: 'k', models: 'model-a,model-b', thinkingLevel: 'low', fetchImpl, retries: 1, sleep: async () => {}, log: (l) => lines.push(l) });
        expect(await ai.json({ prompt: 'x' })).toEqual({ a: 1 });
        const a = calls.filter((c) => c[0].includes('model-a'));
        const b = calls.filter((c) => c[0].includes('model-b'));
        expect(cfg(a[0])).toEqual({ thinkingLevel: 'low' });     // asked with it, refused
        expect(cfg(a[1])).toBeUndefined();                       // repeated without it
        expect(cfg(b[0])).toEqual({ thinkingLevel: 'low' });     // the other model still gets the cap
        expect(lines.some((l) => /model-a refused the thinking setting.*for this model/.test(l))).toBe(true);
    });

    test('the usage line names the models that did not accept the setting', async () => {
        const lines = [];
        const answers = [refuse(), good()];
        const ai = createGemini({ apiKey: 'k', models: 'model-a', thinkingLevel: 'low', fetchImpl: async () => answers.shift(), sleep: async () => {}, log: (l) => lines.push(l) });
        await ai.json({ prompt: 'x' });
        ai.printUsage();
        expect(lines[lines.length - 1]).toMatch(/thinking setting: \{"thinkingLevel":"low"\}, not accepted by model-a/);
    });
});

describe('the Gemini client: cooldown and the thinking check', () => {
    const good = () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: {} }) });
    const limited = () => ({ ok: false, status: 429, json: async () => ({}) });
    beforeEach(() => { delete process.env.GEMINI_MODELS; delete process.env.GEMINI_THINKING_LEVEL; });

    test('after a 429 the run stays on the second model for a while, then tries the first again', async () => {
        let clock = 0;
        const lines = [];
        const urls = [];
        let aLimited = true;
        const fetchImpl = jest.fn(async (url) => { urls.push(url.includes('model-a') ? 'a' : 'b'); return url.includes('model-a') ? (aLimited ? limited() : good()) : good(); });
        const ai = createGemini({ apiKey: 'k', models: 'model-a,model-b', fetchImpl, sleep: async () => { throw new Error('a 429 must not wait'); }, now: () => clock, cooldownMs: 120000, log: (l) => lines.push(l) });
        await ai.json({ prompt: 'x' });
        expect(urls).toEqual(['a', 'b']);                      // a was limited, b answered
        clock = 30000; urls.length = 0;
        await ai.json({ prompt: 'y' });
        expect(urls).toEqual(['b']);                           // within the cooldown: straight to b
        aLimited = false; clock = 130000; urls.length = 0;
        await ai.json({ prompt: 'z' });
        expect(urls).toEqual(['a']);                           // the per-minute limit is over: back on the preferred model
        expect(ai.model).toBe('model-a');
        expect(lines.some((l) => /trying model-a again/.test(l))).toBe(true);
    });

    test('if the first model is still limited after the cooldown, it moves on at once (one quick request)', async () => {
        let clock = 0;
        const urls = [];
        const fetchImpl = jest.fn(async (url) => { urls.push(url.includes('model-a') ? 'a' : 'b'); return url.includes('model-a') ? limited() : good(); });
        const ai = createGemini({ apiKey: 'k', models: 'model-a,model-b', fetchImpl, sleep: async () => { throw new Error('no waiting'); }, now: () => clock, cooldownMs: 1000, log: () => {} });
        await ai.json({ prompt: 'x' });
        clock = 5000; urls.length = 0;
        await ai.json({ prompt: 'y' });
        expect(urls).toEqual(['a', 'b']);
        expect(ai.model).toBe('model-b');
    });

    test('a 400 that merely contains the word "think" is not taken for a thinking-setting error', async () => {
        const fetchImpl = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'I think the request is malformed' } }) }));
        const ai = createGemini({ apiKey: 'k', thinkingLevel: 'low', fetchImpl, log: () => {} });
        await expect(ai.json({ prompt: 'x' })).rejects.toThrow(/malformed/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);            // no retry without the setting
    });

    test('a 400 about thinking still drops the setting for that model', async () => {
        const answers = [{ ok: false, status: 400, json: async () => ({ error: { message: 'thinking_config.thinking_level is invalid for this model' } }) }, good()];
        const fetchImpl = jest.fn(async () => answers.shift());
        const ai = createGemini({ apiKey: 'k', thinkingLevel: 'low', fetchImpl, log: () => {} });
        expect(await ai.json({ prompt: 'x' })).toEqual({ a: 1 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

