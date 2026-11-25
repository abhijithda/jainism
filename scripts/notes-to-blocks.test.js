// Tests for scripts/notes-to-blocks.js. The AI is always a fake here: nothing touches the network.
const fs = require('fs');
const path = require('path');
const retrieval = require('../src/ai/retrieval.js');
const { processDraft } = require('./content-agent');
const {
    parseInbox, prepare, stripVideoLinks, detectLang, fallbackPlan, validatePlan, makePlan, buildItems,
    verifyPreservation, translateBlocks, convertNotes, numberAndMark,
    reportLabel, tidyPairs,
} = require('./notes-to-blocks');

const FIX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const EX1 = FIX('notes-example-1.txt');
const EX2 = FIX('notes-example-2.txt');
const realData = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data.json'), 'utf8'));
// the number the next new item gets, whatever the real data.json holds today (it grows with every merged PR)
const nextNum = (d) => Math.max(0, ...d.filter((i) => Number.isInteger(i.num)).map((i) => i.num)) + 1;

/** A fake model: `plan(prompt)` answers the split request, translation echoes lines with a prefix. */
function fakeAi({ plan, translate } = {}) {
    const calls = [];
    return {
        available: true,
        calls,
        json: async ({ system, prompt }) => {
            calls.push({ system, prompt });
            if (/split rough notes/.test(system)) return plan ? plan(prompt) : { items: [] };
            const m = prompt.match(/\{"blocks".*$/s);
            const input = JSON.parse(m[0]);
            const to = /to English/.test(prompt) ? 'EN' : 'KN';
            return { blocks: input.blocks.map((b) => ({ key: b.key, lines: translate ? translate(b, to) : b.lines.map((l) => `[${to}] ${l}`) })) };
        },
    };
}

const flatten = (items, lang) => items.flatMap((i) => i.blocks.flatMap((b) => b.content[lang]));

describe('reading a file', () => {
    test('an optional header sets after / lang / followup, and is not part of the text', () => {
        const { options, rawLines } = parseInbox('---\nafter: A-11\nlang: kn\nfollowup: yes\n---\nಒಂದು\n');
        expect(options).toEqual({ after: 'A-11', lang: 'kn', followup: true });
        expect(rawLines[0]).toBe('ಒಂದು');
    });
    test('YouTube links leave the line (with ?t= kept on the entry); other links stay', () => {
        const p = prepare(['See https://youtu.be/-6Xivr3u_JI?t=307 and https://forms.gle/abc for more.']);
        expect(p.lines[0].text).toBe('See and https://forms.gle/abc for more.');
        expect(p.videos).toEqual([{ url: 'https://youtu.be/-6Xivr3u_JI?t=307', anchor: 0 }]);
        expect(p.otherLinks).toEqual(['https://forms.gle/abc']);
    });
    test('a link on its own line belongs to the text line above; a link before any text to the first line', () => {
        const p = prepare(['https://youtu.be/aaaaaaaaaaa', 'first', 'https://youtu.be/bbbbbbbbbbb', 'second']);
        expect(p.videos.map((v) => [v.url.slice(-11), v.anchor])).toEqual([['aaaaaaaaaaa', 0], ['bbbbbbbbbbb', 0]]);
        expect(p.lines.map((l) => l.text)).toEqual(['first', 'second']);
    });
    test('trailing punctuation and spaces after a link are not part of it', () => {
        const { text, videos } = stripVideoLinks('watch (https://www.youtube.com/shorts/5iPr8mqvu7E).  ');
        expect(videos).toEqual(['https://www.youtube.com/shorts/5iPr8mqvu7E']);
        expect(text).toBe('watch.');
    });
    test('the Q/A prefixes (Kannada and English) are dropped and decide the items', () => {
        const p = prepare(['ಪ್ರಶ್ನೆ ಕರ್ತ: ಏಕೆ?', 'Answer: Because.', 'more', 'Inquirer: Next?', 'ಉತ್ತರ: Yes.']);
        expect(p.lines.map((l) => l.text)).toEqual(['ಏಕೆ?', 'Because.', 'more', 'Next?', 'Yes.']);
        expect(p.lines.map((l) => l.marker)).toEqual(['question', 'answer', null, 'question', 'answer']);
        expect(p.prefixesDropped).toBe(4);
    });
    test('a prefix on a line by itself marks the next text line', () => {
        const p = prepare(['ಉತ್ತರ:', 'text']);
        expect(p.lines).toEqual([{ text: 'text', blankBefore: false, marker: 'answer' }]);
    });
    test('language is the script with more letters', () => {
        expect(detectLang(['ಅಭಿಷೇಕ ಮಾಡುವುದು'])).toBe('kn');
        expect(detectLang(['Padma Charitam: Indrani does abhisheka'])).toBe('en');
        expect(detectLang(['1. ಣವಣ / Navana  = Abhishekas'])).toBe('en');
    });
});

describe('the plan', () => {
    const lines = prepare(EX2.split('\n')).lines;
    test('the rule-based plan splits on blank lines and numbered points, and covers every line once', () => {
        const plan = fallbackPlan(lines);
        expect(() => validatePlan(plan, lines)).not.toThrow();
        const heads = plan.items[0].blocks.map((b) => lines[b.from].text.slice(0, 3));
        expect(heads).toEqual(expect.arrayContaining(['1. ', '2. ', '3. ']));
    });
    test('a plan with a gap, an overlap, a bad type or a missing line is rejected', () => {
        const mk = (blocks, type = 'answer') => ({ items: [{ type, blocks }] });
        const l = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
        expect(() => validatePlan(mk([{ type: 'paragraph', from: 0, to: 0 }, { type: 'paragraph', from: 2, to: 2 }]), l)).toThrow(/gaps|line 1 is next/);
        expect(() => validatePlan(mk([{ type: 'paragraph', from: 0, to: 1 }, { type: 'paragraph', from: 1, to: 2 }]), l)).toThrow();
        expect(() => validatePlan(mk([{ type: 'poem', from: 0, to: 2 }]), l)).toThrow(/unknown type/);
        expect(() => validatePlan(mk([{ type: 'paragraph', from: 0, to: 1 }]), l)).toThrow(/covers 2 of 3/);
        expect(() => validatePlan(mk([{ type: 'paragraph', from: 0, to: 2 }]), l)).not.toThrow();
    });
    test('with Q/A prefixes the AI cannot change the items', () => {
        const l = prepare(['Q: one?', 'A: two.', 'three.']).lines;
        const bad = { items: [{ type: 'answer', blocks: [{ type: 'paragraph', from: 0, to: 2 }] }] };
        expect(() => validatePlan(bad, l)).toThrow(/prefixes/);
    });
    test('a bad AI answer is retried once with the error, then the rule-based plan is used', async () => {
        const ai = fakeAi({ plan: () => ({ items: [{ type: 'answer', blocks: [{ type: 'paragraph', from: 0, to: 0 }] }] }) });
        const r = await makePlan(ai, lines);
        expect(r.source).toBe('rules');
        expect(ai.calls).toHaveLength(2);
        expect(ai.calls[1].prompt).toMatch(/rejected/);
        expect(r.note).toMatch(/not usable/);
    });
    test('a good AI answer is used', async () => {
        const n = lines.length;
        const ai = fakeAi({ plan: () => ({ items: [{ type: 'answer', blocks: [{ type: 'note', from: 0, to: n - 1, tags: 'abhisheka  jaya dhawala' }] }] }) });
        const r = await makePlan(ai, lines);
        expect(r.source).toBe('ai');
    });
    test('without a key the rules are used and the note says so', async () => {
        const r = await makePlan({ available: false }, lines);
        expect(r.source).toBe('rules');
        expect(r.note).toMatch(/GEMINI_API_KEY/);
    });
});

describe('lines in equal lines out', () => {
    for (const [name, text] of [['example 1', EX1], ['example 2', EX2]]) {
        test(`${name}: every line comes out unchanged, in order (only prefixes, links, blanks, edge spaces removed)`, async () => {
            const ai = fakeAi({});
            const r = await convertNotes(text, realData(), { ai: { ...ai, available: false }, name });
            const added = r.data.slice(realData().length);
            const out = added.flatMap((i) => i.blocks.flatMap((b) => [...b.content.kn, ...b.content.en]));
            const expected = text.split(/\r?\n/)
                .map((l) => l.trim().replace(/^(ಪ್ರಶ್ನೆ ಕರ್ತ|ಉತ್ತರ):\s*/u, '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            expect(out.map((l) => l.replace(/\s+/g, ' '))).toEqual(expected);
        });
    }
    test('the proof fails when a block line is altered', () => {
        const p = prepare(EX1.split('\n'));
        const built = buildItems(p, fallbackPlan(p.lines));
        built.items[1].blocks[0].content.kn[0] += '!';
        expect(() => verifyPreservation(EX1, built.items, built.meta)).toThrow(/changed/);
    });
    test('the proof fails when a line is dropped', () => {
        const p = prepare(EX1.split('\n'));
        const built = buildItems(p, fallbackPlan(p.lines));
        built.items[1].blocks[0].content.kn.pop();
        expect(() => verifyPreservation(EX1, built.items, built.meta)).toThrow(/differ/);
    });
    test('even a model that "improves" the text through the translation call cannot change your lines', async () => {
        const ai = fakeAi({ translate: (b) => b.lines.map((l) => l.toUpperCase()) });
        const r = await convertNotes(EX1, realData(), { ai: { ...ai, json: async (req) => (/split rough notes/.test(req.system) ? { items: [] } : ai.json(req)) } });
        expect(r.count).toBe(2); // fell back to rules, still verified
    });
});

describe('example 1 (a Q&A from the Google Doc)', () => {
    test('one question with one block, one answer with a block of the first lines and one for the Vidyasagar line with the video', async () => {
        const r = await convertNotes(EX1, realData(), { ai: { available: false } });
        const [q, a] = r.data.slice(-2);
        expect(q.type).toBe('question');
        expect(q.blocks).toHaveLength(1);
        expect(q.blocks[0].content.kn).toEqual(['ಪಂಚಾಮೃತ ಅಭಿಷೇಕವು ಹಿಂದೂಗಳಿಂದ ಜೈನರಿಗೆ ಬಂದದ್ದಲ್ಲವೇ?']);
        expect(a.type).toBe('answer');
        expect(a.blocks).toHaveLength(2);
        expect(a.blocks[0].content.kn).toHaveLength(3);
        expect(a.blocks[0].videos).toEqual([]);
        expect(a.blocks[1].content.kn[0]).toMatch(/^ಆಚಾರ್ಯ ವಿದ್ಯಾಸಾಗರ ಮಹಾರಾಜರ/);
        expect(a.blocks[1].content.kn[0]).not.toMatch(/youtu/);
        expect(a.blocks[1].videos).toEqual([{ url: 'https://youtu.be/cZjPOAdWk9E?si=F3UA1Gn8iUAMddH8', youtubeId: 'cZjPOAdWk9E' }]);
        const starts = r.data.slice(-2).flatMap((i) => i.blocks.flatMap((b) => b.content.kn));
        expect(starts.some((l) => /^(ಪ್ರಶ್ನೆ ಕರ್ತ|ಉತ್ತರ):/.test(l))).toBe(false);   // (the last line legitimately ends with "ಉತ್ತರ:")
    });
    test('the question gets the next num, the answer none (it shares the question\'s number)', async () => {
        const data = realData();
        const r = await convertNotes(EX1, data, { ai: { available: false } });
        const [q, a] = r.data.slice(-2);
        expect(q.num).toBe(nextNum(data));
        expect(a.num).toBeUndefined();
        expect(a._agent).toBeUndefined();
    });
    test('the English is machine-translated, line for line, listed for review, and Kannada is never overwritten', async () => {
        const data = realData();
        const r = await convertNotes(EX1, data, { ai: fakeAi({}) });
        const [q, a] = r.data.slice(-2);
        expect(q.blocks[0].content.kn).toHaveLength(1);
        expect(q.blocks[0].content.en).toEqual(['[EN] ' + q.blocks[0].content.kn[0]]);
        expect(a.blocks[0].content.en).toHaveLength(a.blocks[0].content.kn.length);
        expect(r.report).toMatch(/Machine-translated: review this/);
        expect(r.report).toMatch(new RegExp(`Q-${nextNum(data)}\\.1 → English`));
        // everything was translated into English: the heading says English once, not "English or English"
        expect(r.report).toMatch(/Machine-translated: review this \(English; never overwrites/);
        expect(r.report).not.toMatch(/English or English/);
        expect(r.report).toMatch(/lines in your text are exactly the lines/);
    });
});

describe('example 2 (rough notes)', () => {
    // what a good model would answer: heading, then each numbered point, then the second heading and the story
    const goodPlan = (lines) => () => {
        const idx = (re) => lines.findIndex((l) => re.test(l.text));
        const starts = [0, idx(/^1\./), idx(/^2\./), idx(/^3\./), idx(/^4\./), idx(/^5\./), idx(/^6\./), idx(/^Abhisheka, Charchana/), idx(/^ದೇಶಭೂಷಣ/)];
        const blocks = starts.map((from, k) => ({ type: 'paragraph', from, to: (starts[k + 1] ?? lines.length) - 1, tags: k === 0 ? 'abhisheka jaya dhawala' : '' }));
        return { items: [{ type: 'answer', blocks: blocks.slice(0, 8) }, { type: 'answer', blocks: [{ ...blocks[8], tags: 'story deshabhushana kulabhushana' }] }] };
    };
    const lines = prepare(EX2.split('\n')).lines;

    test('a standalone answer gets its own num and the marker that stops the pipeline treating it as a follow-up', async () => {
        const r = await convertNotes(EX2, realData(), { ai: fakeAi({ plan: goodPlan(lines) }) });
        const added = r.data.slice(realData().length);
        expect(added.map((i) => [i.type, i.num])).toEqual([['answer', nextNum(realData())], ['answer', nextNum(realData()) + 1]]);
        expect(added.every((i) => i._agent && i._agent.standalone)).toBe(true);
    });
    test('videos stay with the block whose text they follow, ?t= kept, none left in the text', async () => {
        const r = await convertNotes(EX2, realData(), { ai: fakeAi({ plan: goodPlan(lines) }) });
        const blocks = r.data.slice(realData().length).flatMap((i) => i.blocks);
        const all = blocks.flatMap((b) => b.videos.map((v) => v.url));
        expect(all).toContain('https://youtu.be/-6Xivr3u_JI?t=307');
        expect(all).toContain('https://www.youtube.com/shorts/BhjW6NQn6kQ');
        expect(JSON.stringify(blocks.map((b) => b.content))).not.toMatch(/youtu/);
        const padma = blocks.find((b) => b.content.en.some((l) => /Padma Charitam/.test(l)));
        expect(padma.videos.map((v) => v.youtubeId)).toEqual(['BhjW6NQn6kQ', '8TUoBrUKCrc', '9ndUDXwBhIs']);
    });
    test('each block is in the language it was written in; the other one is the translation', async () => {
        const r = await convertNotes(EX2, realData(), { ai: fakeAi({ plan: goodPlan(lines) }) });
        const story = r.data[r.data.length - 1].blocks[0];
        expect(story.content.kn[0]).toMatch(/^ದೇಶಭೂಷಣ/);
        expect(story.content.en[0]).toMatch(/^\[EN\]/);
        const point = r.data[realData().length].blocks.find((b) => b.content.en.some((l) => /^3\. Pushpa Vrusti/.test(l)));
        expect(point.content.kn).toEqual(['[KN] 3. Pushpa Vrusti:']);
    });
    test('tags are suggested in the report and never written', async () => {
        const r = await convertNotes(EX2, realData(), { ai: fakeAi({ plan: goodPlan(lines) }) });
        expect(r.report).toMatch(/Suggested tags \(not written/);
        expect(r.report).toMatch(/abhisheka jaya dhawala/);
        expect(r.data.slice(realData().length).flatMap((i) => i.blocks).every((b) => b.tags.length === 0)).toBe(true);
    });
    test('a translation with the wrong number of lines is retried once, then listed as missing and left empty', async () => {
        const ai = fakeAi({ plan: goodPlan(lines), translate: (b) => b.lines.slice(1) });
        const r = await convertNotes(EX2, realData(), { ai });
        const blocks = r.data.slice(realData().length).flatMap((i) => i.blocks);
        const multi = blocks.find((b) => b.content.en.length > 1);
        expect(multi.content.kn).toEqual([]);
        expect(r.report).toMatch(/Missing translations/);
        expect(r.report).toMatch(/same number of lines/);
    });
    test('shloka and mantra blocks are transliterated, not translated, and flagged for checking', async () => {
        const l = prepare(['ॐ ह्रीं नमः', 'ಓಂ']).lines;
        const items = [{ type: 'answer', blocks: [{ num: 1, type: 'mantra', content: { kn: [], en: ['Om hreem namah'] }, tags: [], videos: [], images: [] }] }];
        const meta = [{ blocks: [{ lang: 'en', other: 'kn' }] }];
        const ai = fakeAi({});
        await translateBlocks(ai, items, meta);
        expect(ai.calls[0].prompt).toMatch(/"mode":"transliterate"/);
    });
});

describe('where it goes and how the existing pipeline takes over', () => {
    test('--after puts the items right after that place; nums are still the next free ones', async () => {
        const data = realData();
        const r = await convertNotes(EX1, data, { ai: { available: false }, after: 'A-11' });
        const i = r.data.findIndex((x) => x.num === nextNum(data));
        expect(i).toBeGreaterThan(0);
        expect(i).toBeLessThan(data.length);
        expect(r.data.slice(0, i)).toEqual(data.slice(0, i));
        expect(r.data.slice(i + 2)).toEqual(data.slice(i));
    });
    test('an unknown place is a clear error and nothing is written', async () => {
        await expect(convertNotes(EX1, realData(), { ai: { available: false }, after: 'A-99' })).rejects.toThrow(/cannot find A-99/);
    });
    test('followup: yes leaves a note-style answer to be linked by the pipeline as a follow-up of the answer above', () => {
        const data = [{ id: 'aaaaaa', num: 1, type: 'answer', blocks: [] }];
        const items = [{ type: 'answer', blocks: [] }];
        expect(numberAndMark(data, 1, items, { followup: true })[0]._agent).toBeUndefined();
        expect(numberAndMark(data, 1, items, {})[0]._agent).toEqual({ standalone: true });
    });
    test('end to end with content-agent: ids, timestamps, no follow-up guess for a standalone answer, no marker left', async () => {
        const data = realData();
        const r = await convertNotes(EX2, data, { ai: { available: false } });
        const out = processDraft(r.data, { retrieval, now: new Date('2026-11-19T10:00:00Z'), minScore: 1000 });
        const added = out.data.slice(data.length);
        expect(added[0].id).toMatch(/^[a-z][2-9a-z]{5}$/);
        expect(added[0].timestamp).toBe('2026-11-19T10:00:00Z');
        expect(added[0].references).toBeUndefined();         // not linked to the answer above
        expect(added[0].num).toBe(nextNum(data));
        expect(JSON.stringify(out.data)).not.toMatch(/_agent/);
        expect(added[0].blocks.every((b) => /^[a-z][2-9a-z]{5}$/.test(b.id))).toBe(true);
    });
    test('an answer right below an existing question is linked to it by the pipeline and takes no num', async () => {
        const data = realData();
        const q = data.find((i) => i.type === 'question' && i.num === 5);
        const r = await convertNotes('ಉತ್ತರ: ಹೌದು.', data, { ai: { available: false }, after: q.id });
        const added = r.data[data.indexOf(q) + 1];
        expect(added.num).toBeUndefined();
        const out = processDraft(r.data, { retrieval, now: new Date('2026-11-19T10:00:00Z'), minScore: 1000 });
        expect(out.data[data.indexOf(q) + 1].references).toEqual([q.id]);
    });
});

describe('report labels match the book', () => {
    test('a note is N, a shloka S, a mantra M, a plain paragraph takes its item letter', () => {
        const answer = { type: 'answer' };
        expect(reportLabel(answer, { type: 'paragraph', num: 1 }, 29)).toBe('A-29.1');
        expect(reportLabel(answer, { type: 'note', num: 8 }, 29)).toBe('N-29.8');
        expect(reportLabel(answer, { type: 'shloka', num: 2 }, 29)).toBe('S-29.2');
        expect(reportLabel(answer, { type: 'mantra', num: 3 }, 29)).toBe('M-29.3');
        expect(reportLabel({ type: 'question' }, { type: 'paragraph', num: 1 }, 31)).toBe('Q-31.1');
        expect(reportLabel(answer, { type: 'paragraph', num: 1 }, undefined)).toBe('A-?.1');
    });
});

describe('a Kannada word the writer typed next to its Latin spelling', () => {
    test('the Kannada translation keeps only the writer\'s own Kannada word (no second spelling)', () => {
        expect(tidyPairs('1. ಣವಣ / Navana  = Abhishekas', '1. ಣವಣ / ನವಣ = ಅಭಿಷೇಕಗಳು', 'kn')).toBe('1. ಣವಣ = ಅಭಿಷೇಕಗಳು');
        expect(tidyPairs('2. ಉಪ ಲೇಪನ / Upa Lepana', '2. ಉಪ ಲೇಪನ / ಉಪಲೇಪನ: ಉದಾಹರಣೆಗಳು', 'kn')).toBe('2. ಉಪ ಲೇಪನ: ಉದಾಹರಣೆಗಳು');
        expect(tidyPairs('2. ಉಪ ಲೇಪನ / Upa Lepana', '2. ಉಪ ಲೇಪನ / ಉಪ ಲೇಪನ', 'kn')).toBe('2. ಉಪ ಲೇಪನ');
    });
    test('it removes at most one more word, so the rest of the line is never lost', () => {
        expect(tidyPairs('x ಉಪ ಲೇಪನ / Upa Lepana done', 'x ಉಪ ಲೇಪನ / ಉಪಲೇಪನ ಮಾಡಿದ', 'kn')).toBe('x ಉಪ ಲೇಪನ ಮಾಡಿದ');
    });
    test('a slash the writer did not type next to Latin letters is left alone', () => {
        expect(tidyPairs('plain English', 'ಯಾವುದೋ ಸಾಲು / ಇನ್ನೊಂದು', 'kn')).toBe('ಯಾವುದೋ ಸಾಲು / ಇನ್ನೊಂದು');
    });
    test('an English translation has only the Latin word: "ಣವಣ / Navana" becomes "Navana"', () => {
        expect(tidyPairs('ಣವಣ / Navana = x', 'ಣವಣ / Navana = Abhishekas', 'en')).toBe('Navana = Abhishekas');
        expect(tidyPairs('plain', 'a plain English line', 'en')).toBe('a plain English line');
    });
    test('translateBlocks applies it to the lines the model returns', async () => {
        const items = [{ type: 'answer', blocks: [{ num: 1, type: 'paragraph', content: { kn: [], en: ['1. ಣವಣ / Navana  = Abhishekas'] }, tags: [], videos: [], images: [] }] }];
        const meta = [{ blocks: [{ lang: 'en', other: 'kn' }] }];
        const ai = { available: true, json: async ({ prompt }) => ({ blocks: [{ key: '0.0', lines: ['1. ಣವಣ / ನವಣ = ಅಭಿಷೇಕಗಳು'] }] }) };
        await translateBlocks(ai, items, meta);
        expect(items[0].blocks[0].content.kn).toEqual(['1. ಣವಣ = ಅಭಿಷೇಕಗಳು']);
    });
    test('the translation prompt states the rule', async () => {
        const items = [{ type: 'answer', blocks: [{ num: 1, type: 'paragraph', content: { kn: [], en: ['x'] }, tags: [], videos: [], images: [] }] }];
        const meta = [{ blocks: [{ lang: 'en', other: 'kn' }] }];
        let system = '';
        await translateBlocks({ available: true, json: async (o) => { system = o.system; return { blocks: [] }; } }, items, meta);
        expect(system).toMatch(/keep ONLY the writer's own Kannada word/);
    });
});

describe('when Gemini itself is down (busy after every retry): stop and change nothing', () => {
    const down = () => { const e = new Error('Gemini answered 503 (busy or rate-limited)'); e.unavailable = true; return e; };

    test('the split: the error goes up, nothing is returned to write', async () => {
        const ai = { available: true, json: async () => { throw down(); } };
        const err = await convertNotes(EX1, realData(), { ai }).catch((e) => e);
        expect(err.unavailable).toBe(true);
        expect(err.message).toMatch(/503/);
    });

    test('the translation: the error goes up too, instead of leaving empty languages behind', async () => {
        const items = [{ type: 'answer', blocks: [{ num: 1, type: 'paragraph', content: { kn: [], en: ['hello'] }, tags: [], videos: [], images: [] }] }];
        const meta = [{ blocks: [{ lang: 'en', other: 'kn' }] }];
        const ai = { available: true, json: async () => { throw down(); } };
        await expect(translateBlocks(ai, items, meta)).rejects.toMatchObject({ unavailable: true });
        expect(items[0].blocks[0].content.kn).toEqual([]);
    });

    test('an answer that simply was not usable still falls back to the rule-based split', async () => {
        const ai = { available: true, json: async () => ({ nothing: 'useful' }) };
        const r = await convertNotes(EX1, realData(), { ai });
        expect(r.report).toMatch(/the AI split was not usable/);
        expect(r.count).toBeGreaterThan(0);
    });

    test('a translation error that is not an outage is listed as a missing translation, as before', async () => {
        const items = [{ type: 'answer', blocks: [{ num: 1, type: 'paragraph', content: { kn: [], en: ['hello'] }, tags: [], videos: [], images: [] }] }];
        const meta = [{ blocks: [{ lang: 'en', other: 'kn' }] }];
        const ai = { available: true, json: async () => { throw new Error('Gemini answered 400: bad'); } };
        await translateBlocks(ai, items, meta);
        expect(meta[0].blocks[0].translationNote).toMatch(/translation failed/);
    });
});

describe('tidyPairs: every pair in a line', () => {
    test('two pairs in one line are both reduced to the writer\'s own Kannada word', () => {
        expect(tidyPairs('ಣವಣ / Navana and ಉಪ ಲೇಪನ / Upa Lepana', 'ಣವಣ / ನವಣ ಮತ್ತು ಉಪ ಲೇಪನ / ಉಪಲೇಪನ', 'kn')).toBe('ಣವಣ ಮತ್ತು ಉಪ ಲೇಪನ');
    });
    test('the same pair twice in a line is reduced both times', () => {
        expect(tidyPairs('ಣವಣ / Navana, ಣವಣ / Navana', 'ಣವಣ / ನವಣ, ಣವಣ / ನವಣ', 'kn')).toBe('ಣವಣ, ಣವಣ');
    });
    test('English output: every pair becomes the Latin word', () => {
        expect(tidyPairs('x', 'ಣವಣ / Navana, ಉಪ ಲೇಪನ / Upa Lepana', 'en')).toBe('Navana, Upa Lepana');
    });
});

