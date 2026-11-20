const A = require('./study-ai.js');

const passages = [
    { id: 'b1', label: 'A-1.1', text: { en: 'Deva Moodhata is delusion about Bhagawan.' } },
    { id: 'b2', label: 'A-1.2', text: { en: 'Loka Moodhata is delusion about the world.' } },
];
const engine = (id, ok = true, reply = '') => ({ id, available: () => ({ ok }), generate: jest.fn(async () => reply) });

describe('aiAvailable', () => {
    test('only hosted engines that are usable', () => {
        expect(A.aiAvailable(engine('cloud'))).toBe(true);
        expect(A.aiAvailable(engine('custom'))).toBe(true);
        expect(A.aiAvailable(engine('local'))).toBe(false);          // small on-device models: no
        expect(A.aiAvailable(engine('cloud', false))).toBe(false);   // not set up
        expect(A.aiAvailable(null)).toBe(false);
    });
});

describe('language', () => {
    test('studyLang: English whenever it is selected, else the first language', () => {
        expect(A.studyLang(['kn', 'en'])).toBe('en');
        expect(A.studyLang(['kn'])).toBe('kn');
        expect(A.studyLang([])).toBe('en');
    });

    test('a new question is written in English for a Kannada-first reader who also has English', () => {
        const m = A.buildQuestionMessages({ passages, langs: ['kn', 'en'] });
        expect(m[0].content).toMatch(/Write in English/);
        expect(m[0].content).not.toMatch(/Write in Kannada/);
    });

    test('feedback follows the language the reader answered in', () => {
        const m = A.buildCheckMessages({ question: 'Q?', learnerAnswer: 'my answer', passages, langs: ['kn', 'en'] });
        expect(m[0].content).toMatch(/same language as the reader's answer/);
        expect(m[0].content).toMatch(/unclear, write in English/);
    });
});

describe('parseQuestion', () => {
    test('accepts JSON whose answer cites a real passage (also inside code fences)', () => {
        const reply = '```json\n{"question":"How do they differ?","answer":"One is about Bhagawan [A-1.1], one about the world [A-1.2]."}\n```';
        const q = A.parseQuestion(reply, passages);
        expect(q.question).toBe('How do they differ?');
        expect(q.citations.map(c => c.label)).toEqual(['A-1.1', 'A-1.2']);
    });

    test.each([
        ['not JSON', 'Sure! Here is a question.'],
        ['no citation', '{"question":"Q?","answer":"No cites here."}'],
        ['a made-up label', '{"question":"Q?","answer":"See [A-9.9]."}'],
        ['empty question', '{"question":"","answer":"x [A-1.1]"}'],
        ['missing answer', '{"question":"Q?"}'],
        ['absurdly long question', JSON.stringify({ question: 'q'.repeat(500), answer: 'x [A-1.1]' })],
    ])('rejects %s', (_, reply) => expect(A.parseQuestion(reply, passages)).toBeNull());
});

describe('generateQuestion / checkAnswer', () => {
    test('generateQuestion sends only the passages, with the rules, and returns the validated question', async () => {
        const e = engine('cloud', true, '{"question":"Q?","answer":"Because [A-1.1]."}');
        const q = await A.generateQuestion({ engine: e, passages, langs: ['en'], avoid: ['Old question?'] });
        expect(q.question).toBe('Q?');
        const [messages] = e.generate.mock.calls[0];
        expect(messages[0].content).toMatch(/ONLY the passages/);
        expect(messages[1].content).toContain('[A-1.1]');
        expect(messages[1].content).toContain('Old question?');
    });

    test('checkAnswer returns feedback that cites the book, and null when it cites nothing real', async () => {
        const good = engine('cloud', true, 'You have the first part right [A-1.1].');
        const r = await A.checkAnswer({ engine: good, question: 'Q?', learnerAnswer: 'mine', passages, langs: ['en'] });
        expect(r.citations.map(c => c.label)).toEqual(['A-1.1']);
        expect(good.generate.mock.calls[0][0][1].content).toContain("Reader's answer: mine");

        const bad = engine('cloud', true, 'You are completely right.');
        expect(await A.checkAnswer({ engine: bad, question: 'Q?', learnerAnswer: 'mine', passages, langs: ['en'] })).toBeNull();
    });
});
