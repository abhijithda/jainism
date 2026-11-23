const fs = require('fs');
const path = require('path');
const { createIndex } = require('../ai/retrieval.js');
const Q = require('./study-questions.js');
const { createStudyConfig, loadStudyConfig } = require('./study-config.js');

const root = path.join(__dirname, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'data.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'study-config.json'), 'utf8'));
const config = createStudyConfig(raw);
const model = Q.buildStudyModel(createIndex(data), config);
const bookText = lang => data.flatMap(i => (i.blocks || []).flatMap(b => b.content?.[lang] || [])).join(' \n ');
const knownTopics = () => {
    const known = new Set([...model.topics.values()].map(t => t.name.toLowerCase()));
    model.phrases.forEach(p => known.add(p.toLowerCase()));
    return known;
};

describe('createStudyConfig', () => {
    test('anything that is not a config is the empty config', () => {
        [undefined, null, 5, 'x', [], {}].forEach(raw => {
            const c = createStudyConfig(raw);
            expect(c.topicName('Kali Devi', 'kn')).toBe('Kali Devi');
            expect(c.canonicalTopic('Govadana Yaksha')).toBe('Govadana Yaksha');
            expect(c.aliasesOf('Gomukha Yaksha')).toEqual([]);
            expect(c.isTitleWord('queen')).toBe(false);
        });
    });

    test('lookups ignore case; a topic with no name in that language shows as the tag', () => {
        const c = createStudyConfig({ topicNames: { 'Kali Devi': { kn: 'ಕಾಳಿ ದೇವಿ' } }, aliases: { 'Govadana Yaksha': 'Gomukha Yaksha' }, titleWords: ['Queen'] });
        expect(c.topicName('kali devi', 'kn')).toBe('ಕಾಳಿ ದೇವಿ');
        expect(c.topicName('Kali Devi', 'en')).toBe('Kali Devi');
        expect(c.topicName('Other', 'kn')).toBe('Other');
        expect(c.canonicalTopic('govadana yaksha')).toBe('Gomukha Yaksha');
        expect(c.aliasesOf('GOMUKHA YAKSHA')).toEqual(['Govadana Yaksha']);
        expect(c.aliasEntries()).toEqual([['Govadana Yaksha', 'Gomukha Yaksha']]);
        expect(c.isTitleWord('QUEEN')).toBe(true);
        expect(c.namedTopics('kn')).toEqual(['Kali Devi']);
    });

    test('malformed entries are ignored and reported, never thrown', () => {
        const c = createStudyConfig({
            topicNames: { A: 'kn name', B: { kn: 5 }, C: { kn: ' ok ' }, D: { kn: '' } },
            aliases: { X: 5, Y: 'Y', P: 'Q', Q: 'R' },
            titleWords: ['queen', 7],
            extra: true,
        });
        expect(c.topicName('C', 'kn')).toBe('ok');
        expect(c.topicName('A', 'kn')).toBe('A');
        expect(c.topicName('B', 'kn')).toBe('B');
        expect(c.canonicalTopic('X')).toBe('X');
        expect(c.canonicalTopic('Y')).toBe('Y');
        expect(c.isTitleWord('queen')).toBe(true);
        expect(c.problems).toEqual(expect.arrayContaining([
            expect.stringMatching(/unknown key "extra"/),
            expect.stringMatching(/topicNames "A"/),
            expect.stringMatching(/topicNames "B" "kn"/),
            expect.stringMatching(/alias "X"/),
            expect.stringMatching(/alias "Y" points at itself/),
            expect.stringMatching(/alias "P" points at "Q", which is itself an alias/),
            expect.stringMatching(/titleWords/),
        ]));
        expect(c.problems.some(p => /"D"/.test(p))).toBe(false);          // "" = not filled in yet: fine
    });
});

describe('loadStudyConfig', () => {
    const ok = body => async () => ({ ok: true, json: async () => body });
    test('reads the file', async () => {
        const c = await loadStudyConfig({ fetchFn: ok({ aliases: { A: 'B' } }) });
        expect(c.canonicalTopic('A')).toBe('B');
    });
    test.each([
        ['a missing file (404)', async () => ({ ok: false, status: 404 })],
        ['no network', async () => { throw new TypeError('Failed to fetch'); }],
        ['text that is not JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } })],
    ])('%s gives the empty config, never an error', async (_, fetchFn) => {
        const c = await loadStudyConfig({ fetchFn });
        expect(c.canonicalTopic('A')).toBe('A');
        expect(c.problems).toEqual([]);
    });
    test('asks for assets/study-config.json by default', async () => {
        const fetchFn = jest.fn(ok({}));
        await loadStudyConfig({ fetchFn });
        expect(fetchFn).toHaveBeenCalledWith('assets/study-config.json');
    });
});

describe('assets/study-config.json (this book)', () => {
    test('has nothing malformed', () => expect(config.problems).toEqual([]));

    test.each(Object.entries(raw.topicNames))('%s: every word of its name is in the book\u2019s own text in that language', (topic, names) => {
        Object.entries(names).forEach(([lang, name]) => {
            const text = bookText(lang);
            name.split(/\s+/).forEach(word => expect(text).toContain(word));
        });
    });

    test('every name belongs to a topic the book still has (no stale entries)', () => {
        const known = knownTopics();
        Object.keys(raw.topicNames).forEach(name => expect(known.has(name.toLowerCase())).toBe(true));
    });

    test('every alias points at a topic the book has, and is not itself a topic', () => {
        const known = knownTopics();
        Object.entries(raw.aliases).forEach(([alias, main]) => {
            expect(known.has(main.toLowerCase())).toBe(true);
            expect(known.has(alias.toLowerCase())).toBe(false);
        });
    });

    test('title words are lower-case single words', () => {
        raw.titleWords.forEach(w => expect(w).toMatch(/^[a-z]+$/));
    });

    test('a Kannada question names its topics in Kannada; an English one keeps the tags', () => {
        const id = data.flatMap(i => i.blocks || []).find(b => (b.tags || []).includes('Deva Moodhata')).id;
        const all = new Set(data.flatMap(i => (i.blocks || []).map(b => b.id)));
        const find = langs => Q.suggestionsForRead(model, id, { readSet: all, langs, max: 5 }).find(s => s.id === 'compare:deva moodhata|loka moodhata');
        const kn = find(['kn']);
        expect(kn.prompt).toContain('ದೇವ ಮೂಢತೆ');
        expect(kn.prompt).toContain('ಲೋಕ ಮೂಢತೆ');
        expect(kn.prompt).not.toMatch(/[A-Za-z]/);
        expect(kn.title).toBe('ದೇವ ಮೂಢತೆ vs ಲೋಕ ಮೂಢತೆ');
        expect(find(['en']).prompt).toBe('You just read about Deva Moodhata. Can you explain how it differs from Loka Moodhata?');
        const both = find(['kn', 'en']);
        expect(both.promptLines[0].text).toContain('ದೇವ ಮೂಢತೆ');
        expect(both.promptLines[1].text).toContain('Deva Moodhata');
    });
});

describe('the engine without any book config (another data set, or the file is missing)', () => {
    const bare = Q.buildStudyModel(createIndex(data));          // no config at all
    const id = data.flatMap(i => i.blocks || []).find(b => (b.tags || []).includes('Deva Moodhata')).id;
    const all = new Set(data.flatMap(i => (i.blocks || []).map(b => b.id)));

    test('still asks its questions, naming topics as the tags write them, even in Kannada', () => {
        const s = Q.suggestionsForRead(bare, id, { readSet: all, langs: ['kn'], max: 5 }).find(x => x.id === 'compare:deva moodhata|loka moodhata');
        expect(s.prompt).toContain('Deva Moodhata');
        expect(s.prompt).toContain('Loka Moodhata');
    });

    test('merges nothing and skips no title words: the book\u2019s config is what does that', () => {
        expect(Q.siblingsOf(bare, 'Chakreshwari Yakshi')).toContain('Gomukha Yaksha');
        expect(bare.phrases).toContain('Govadana Yaksha');                       // not folded into Gomukha Yaksha
        expect(Q.siblingsOf(bare, 'Rani Vishalakshi')).toContain('Queen Vishalakshi');
        expect(Q.siblingsOf(model, 'Rani Vishalakshi')).toEqual([]);              // with this book's config it is
    });
});
