const fs = require('fs');
const path = require('path');
const { createIndex } = require('../ai/retrieval.js');
const Q = require('./study-questions.js');
const { TOPIC_NAMES, topicName } = require('./topic-names.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'data.json'), 'utf8'));
const model = Q.buildStudyModel(createIndex(data));
const bookKannada = data.flatMap(i => (i.blocks || []).flatMap(b => b.content?.kn || [])).join(' \n ');

describe('Kannada topic names', () => {
    test.each(Object.entries(TOPIC_NAMES))('%s: every word of its Kannada name is in the book\u2019s own Kannada text', (name, { kn }) => {
        kn.split(/\s+/).forEach(word => expect(bookKannada).toContain(word));
    });

    test('every name belongs to a topic the book still has (no stale entries)', () => {
        const known = new Set([...model.topics.values()].map(t => t.name.toLowerCase()));
        model.phrases.forEach(p => known.add(p.toLowerCase()));
        Object.keys(TOPIC_NAMES).forEach(name => expect(known.has(name.toLowerCase())).toBe(true));
    });

    test('lookup: Kannada when there is a name, the tag as written when there is not (or the language is English)', () => {
        expect(topicName('Kali Devi', 'kn')).toBe('\u0C95\u0CBE\u0CB3\u0CBF \u0CA6\u0CC7\u0CB5\u0CBF');
        expect(topicName('kali devi', 'kn')).toBe(topicName('Kali Devi', 'kn'));
        expect(topicName('Kali Devi', 'en')).toBe('Kali Devi');
        expect(topicName('Some New Tag', 'kn')).toBe('Some New Tag');
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
