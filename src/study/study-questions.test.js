const fs = require('fs');
const path = require('path');
const { createIndex } = require('../ai/retrieval.js');
const Q = require('./study-questions.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'data.json'), 'utf8'));
const model = Q.buildStudyModel(createIndex(data));
const blocksWithTag = tag => [...model.topics.get(tag.toLowerCase()).blockIds];

describe('comparisons', () => {
    test('tags sharing a last word are siblings', () => {
        expect(Q.siblingsOf(model, 'Nishchaya Naya')).toContain('Vyavahara Naya');
    });

    test('a phrase the text names but does not tag counts when the book names it with the topic (Loka Moodhata)', () => {
        const names = Q.siblingsOf(model, 'Deva Moodhata');
        expect(names).toEqual(expect.arrayContaining(['Loka Moodhata', 'Guru Moodhata']));
    });

    test('spelling variants of one topic are not offered as something to compare', () => {
        expect(Q.siblingsOf(model, 'Samyag Drishti')).not.toContain('Samyak Drishti');
        expect(Q.siblingsOf(model, 'Ratnakaranda Shravakachara')).not.toContain('Ratnakarandaka Shravakachara');
    });

    test('a single-word topic has no siblings', () => {
        expect(Q.siblingsOf(model, 'Abhisheka')).toEqual([]);
    });
});

describe('suggestionsForRead', () => {
    const opts = { readSet: new Set(), langs: ['en'] };

    test('reading a Deva Moodhata block offers the Deva vs Loka comparison, with the book\u2019s words for both sides', () => {
        const id = blocksWithTag('Deva Moodhata')[0];
        const first = Q.suggestionsForRead(model, id, { ...opts, readSet: new Set([id]), max: 5 })
            .find(s => s.id === 'compare:deva moodhata|loka moodhata');
        expect(first.kind).toBe('compare');
        expect(first.prompt).toBe('You just read about Deva Moodhata. Can you explain how it differs from Loka Moodhata?');
        const topics = new Set(first.passages.map(p => p.topic));
        expect(topics).toEqual(new Set(['Deva Moodhata', 'Loka Moodhata']));
        // Every passage is the book's own text for a real block.
        first.passages.forEach(p => {
            expect(model.chunkById.get(p.id).text.en).toBe(p.text.en);
        });
    });

    test('a comparison is never offered when the book has nothing for the other side', () => {
        expect(Q.buildSuggestion(model, { kind: 'compare', topics: ['Deva Moodhata', 'Zzzqx Moodhata'] })).toBeNull();
    });

    test('something already answered is not offered again', () => {
        const id = blocksWithTag('Nishchaya Naya')[0];
        const all = Q.suggestionsForRead(model, id, { ...opts, max: 5 });
        const cmp = all.find(s => s.kind === 'compare');
        const done = { [cmp.id]: { status: 'got' } };
        const again = Q.suggestionsForRead(model, id, { ...opts, done, max: 5 });
        expect(again.find(s => s.id === cmp.id)).toBeUndefined();
    });

    test('recall of an answer waits until every readable block of it is read', () => {
        const item = data.find(i => i.type === 'answer' && (i.references || []).length && i.blocks.filter(b => model.chunkById.get(b.id) && !model.chunkById.get(b.id).textless).length > 1);
        const readable = item.blocks.filter(b => model.chunkById.get(b.id) && !model.chunkById.get(b.id).textless);
        const partial = Q.suggestionsForRead(model, readable[0].id, { ...opts, readSet: new Set([readable[0].id]), max: 5 });
        expect(partial.find(s => s.kind === 'recall')).toBeUndefined();
        const full = Q.suggestionsForRead(model, readable[0].id, { ...opts, readSet: new Set(item.blocks.map(b => b.id)), max: 5 });
        const recall = full.find(s => s.kind === 'recall');
        expect(recall).toBeDefined();
        expect(recall.id).toBe(`recall:${item.id}`);
        expect(recall.prompt).toMatch(/^A question from the book: \u201C.+\u201D What does the book answer\?$/);
        expect(recall.passages.length).toBeGreaterThan(0);
    });

    test('inserts (cover, dividers, photos) and unknown blocks give nothing', () => {
        const insert = data.find(i => i.type === 'insert');
        expect(Q.suggestionsForRead(model, insert.blocks[0].id, opts)).toEqual([]);
        expect(Q.suggestionsForRead(model, 'nope', opts)).toEqual([]);
    });

    test('never more than `max`, and no two cards with the same id', () => {
        data.forEach(item => (item.blocks || []).forEach(b => {
            const out = Q.suggestionsForRead(model, b.id, { ...opts, readSet: new Set(item.blocks.map(x => x.id)), max: 2 });
            expect(out.length).toBeLessThanOrEqual(2);
            expect(new Set(out.map(s => s.id)).size).toBe(out.length);
        }));
    });
});

describe('descriptors', () => {
    test('a suggestion can be rebuilt from its descriptor (survives a reload)', () => {
        const id = blocksWithTag('Deva Moodhata')[0];
        const [s] = Q.suggestionsForRead(model, id, { readSet: new Set(), langs: ['en'] });
        const rebuilt = Q.buildSuggestion(model, JSON.parse(JSON.stringify(s.desc)), { langs: ['en'] });
        expect(rebuilt.id).toBe(s.id);
        expect(rebuilt.prompt).toBe(s.prompt);
    });

    test('compare ids do not depend on the order of the two topics', () => {
        expect(Q.suggestionId({ kind: 'compare', topics: ['A B', 'C D'] })).toBe(Q.suggestionId({ kind: 'compare', topics: ['c d', 'a b'] }));
    });

    test('garbage descriptors give null', () => {
        expect(Q.buildSuggestion(model, null)).toBeNull();
        expect(Q.buildSuggestion(model, { kind: 'recall', itemId: 'zzz' })).toBeNull();
        expect(Q.buildSuggestion(model, { kind: 'compare', topics: ['x'] })).toBeNull();
    });
});
