const fs = require('fs');
const path = require('path');
const { createIndex } = require('../ai/retrieval.js');
const Q = require('./study-questions.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'data.json'), 'utf8'));
const { createStudyConfig } = require('./study-config.js');
const config = createStudyConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'study-config.json'), 'utf8')));
const model = Q.buildStudyModel(createIndex(data), config);
const allBlocks = data.flatMap(i => (i.blocks || []).map(b => b.id));
const everythingRead = new Set(allBlocks);
const blocksWithTag = tag => [...model.topics.get(tag.toLowerCase()).blockIds];

describe('comparisons', () => {
    test('tags sharing a last word are siblings', () => {
        expect(Q.siblingsOf(model, 'Nishchaya Naya')).toContain('Vyavahara Naya');
    });

    test('a phrase the text names but does not tag counts when the book names it with the topic (Loka Moodhata)', () => {
        const names = Q.siblingsOf(model, 'Deva Moodhata');
        expect(names).toEqual(expect.arrayContaining(['Loka Moodhata', 'Guru Moodhata']));
    });

    test('one person named two ways (Queen / Rani Vishalakshi) is not offered as a comparison', () => {
        expect(Q.siblingsOf(model, 'Rani Vishalakshi')).toEqual([]);
        expect(Q.siblingsOf(model, 'Queen Vishalakshi')).toEqual([]);
    });

    test('"Yaksha Yakshi" is a pair named together, so it is compared with nothing; its two members are compared with each other', () => {
        expect(Q.siblingsOf(model, 'Yaksha Yakshi')).toEqual([]);
        expect(Q.siblingsOf(model, 'Chakreshwari Yakshi')).toEqual(['Gomukha Yaksha']);
        expect(Q.siblingsOf(model, 'Gomukha Yaksha')).toEqual(['Chakreshwari Yakshi']);
        expect(Q.siblingsOf(model, 'Kali Devi')).toContain('Chakreshwari Devi');   // two different deities: still a comparison
        expect(Q.siblingsOf(model, 'Padma Purana')).toContain('Harivamsha Purana');
    });

    test('a second name for one topic is not a topic of its own: Govadana Yaksha is Gomukha Yaksha', () => {
        expect(Q.comparisonsFor(model, 'Govadana Yaksha')).toEqual([]);
        expect(Q.siblingsOf(model, 'Chakreshwari Yakshi')).not.toContain('Govadana Yaksha');
        expect(model.phrases).not.toContain('Govadana Yaksha');
    });

    test('a shortened name (Vamsha for Harivamsha) is the same name, not a sibling', () => {
        expect(Q.siblingsOf(model, 'Harivamsha Purana')).not.toContain('Vamsha Purana');
        expect(Q.siblingsOf(model, 'Padma Purana')).not.toContain('Vamsha Purana');
        expect(Q.siblingsOf(model, 'Vamsha Purana')).toEqual([]);
        expect(Q.siblingsOf(model, 'Nava Devata')).toContain('Shasana Devata');   // a tag is never an alias, even if another name starts with it
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
    const opts = { readSet: everythingRead, langs: ['en'] };

    test('reading a Deva Moodhata block offers the Deva vs Loka comparison, with the book\u2019s words for both sides', () => {
        const id = blocksWithTag('Deva Moodhata')[0];
        const first = Q.suggestionsForRead(model, id, { ...opts, max: 5 })
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

    test('only what the reader has read: nothing is asked about a topic they have not met', () => {
        const deva = blocksWithTag('Deva Moodhata').find(id => !/Loka Moodhata/.test(model.chunkById.get(id).text.en || ''));
        const loka = allBlocks.find(id => /Loka Moodhata/.test(model.chunkById.get(id)?.text.en || ''));
        const find = readSet => Q.suggestionsForRead(model, deva, { langs: ['en'], readSet, max: 5 }).find(s => s.id === 'compare:deva moodhata|loka moodhata');
        expect(find(new Set([deva]))).toBeUndefined();                 // the Loka Moodhata note is not read yet
        const s = find(new Set([deva, loka]));
        expect(s).toBeDefined();
        s.passages.forEach(p => expect([deva, loka]).toContain(p.id)); // and every passage shown has been read
    });

    test('reading the other side later brings the comparison up then, even if it is only named in the text', () => {
        const textOf = id => model.chunkById.get(id)?.text.en || '';
        const mithya = allBlocks.find(id => /Mithya Drishti/.test(textOf(id)) && !model.chunkById.get(id).tags.includes('Mithya Drishti'));
        const samyag = blocksWithTag('Samyag Drishti').find(id => id !== mithya && !/Mithya Drishti/.test(textOf(id)) && textOf(id));
        const wanted = 'compare:mithya drishti|samyag drishti';
        const find = (blockId, readSet) => Q.suggestionsForRead(model, blockId, { langs: ['en'], readSet, max: 5 }).find(s => s.id === wanted);
        expect(find(samyag, new Set([samyag]))).toBeUndefined();               // the passage about Mithya Drishti is not read yet
        const s = find(mithya, new Set([samyag, mithya]));                     // now it is
        expect(s).toBeDefined();
        s.passages.forEach(p => expect([samyag, mithya]).toContain(p.id));
    });

    test('a comparison is never offered when the book has nothing for the other side', () => {
        expect(Q.buildSuggestion(model, { kind: 'compare', topics: ['Deva Moodhata', 'Zzzqx Moodhata'] }, { readSet: everythingRead })).toBeNull();
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

describe('Gomukha Yaksha and Chakreshwari Yakshi (the first Tirthankara\u2019s attendants)', () => {
    const blockNaming = re => data.flatMap(i => i.blocks || []).find(b => re.test((b.content?.en || []).join(' '))).id;
    const gomukha = blockNaming(/Gomukha Yaksha and Chakreshwari Yakshi/);
    const govadana = blockNaming(/Govadana Yaksha and Chakreshwari Yakshi/);
    const offered = (id, langs = ['en']) => Q.suggestionsForRead(model, id, { readSet: new Set([id]), langs, max: 5 }).find(s => s.id === 'compare:chakreshwari yakshi|gomukha yaksha');

    test('reading the passage that names both offers the comparison, with that one passage shown for both', () => {
        const s = offered(gomukha);
        expect(s.prompt).toBe('You just read about Chakreshwari Yakshi. Can you explain how it differs from Gomukha Yaksha?');
        expect(s.passages.map(p => p.id)).toEqual([gomukha]);
        expect(s.passages[0].topic).toBe('Chakreshwari Yakshi \u00B7 Gomukha Yaksha');
    });

    test('the passage that says Govadana counts as Gomukha: same comparison, from that passage', () => {
        const s = offered(govadana);
        expect(s).toBeDefined();
        expect(s.passages.map(p => p.id)).toEqual([govadana]);
        expect(Q.topicsOf(model, model.chunkById.get(govadana))).toContain('Gomukha Yaksha');
        expect(Q.topicsOf(model, model.chunkById.get(govadana))).not.toContain('Govadana Yaksha');
    });

    test('nothing is asked before either passage is read', () => {
        expect(Q.suggestionsForRead(model, gomukha, { readSet: new Set(), langs: ['en'], max: 5 }).find(s => s.id.startsWith('compare:chakreshwari yakshi'))).toBeUndefined();
    });

    test('in Kannada the two are named in Kannada', () => {
        const s = offered(gomukha, ['kn']);
        expect(s.prompt).toContain('ಚಕ್ರೇಶ್ವರಿ ಯಕ್ಷಿ');
        expect(s.prompt).toContain('ಗೋಮುಖ ಯಕ್ಷ');
        expect(s.prompt).not.toMatch(/[A-Za-z]/);
    });
});

describe('Shasanaadi Devata (Shasana Devata and the other devatas)', () => {
    const blockId = data.flatMap(i => i.blocks || []).find(b => /Shasanaadi Devata/.test((b.content?.en || []).join(' '))).id;
    const everything = new Set(allBlocks);

    test('is the Shasana Devata tag, not a topic of its own: one comparison, not two', () => {
        expect(Q.siblingsOf(model, 'Shasanaadi Devata')).toEqual([]);
        expect(Q.siblingsOf(model, 'Vidya Devata')).not.toContain('Shasanaadi Devata');
        expect(Q.topicsOf(model, model.chunkById.get(blockId))).not.toContain('Shasanaadi Devata');
        const out = Q.suggestionsForRead(model, blockId, { readSet: everything, langs: ['en'], max: 5 });
        expect(out.filter(s => /shasana/.test(s.id))).toHaveLength(1);
        expect(out.some(s => /shasanaadi/.test(s.id))).toBe(false);
    });

    test('even a block that says it without the tag counts as Shasana Devata', () => {
        const untagged = JSON.parse(JSON.stringify(data));
        untagged.forEach(i => (i.blocks || []).forEach(b => { if (b.id === blockId) b.tags = (b.tags || []).filter(t => t !== 'Shasana Devata'); }));
        const m = Q.buildStudyModel(createIndex(untagged), config);
        expect(Q.topicsOf(m, m.chunkById.get(blockId))).toContain('Shasana Devata');
        expect(Q.topicsOf(m, m.chunkById.get(blockId))).not.toContain('Shasanaadi Devata');
    });
});

describe('wording follows the selected languages', () => {
    const id = blocksWithTag('Deva Moodhata')[0];
    const build = langs => Q.suggestionsForRead(model, id, { readSet: everythingRead, langs, max: 5 }).find(s => s.id === 'compare:deva moodhata|loka moodhata');
    const hasKannada = t => /[\u0C80-\u0CFF]/.test(t);

    test('Kannada only: the question is in Kannada, with no English sentence', () => {
        const s = build(['kn']);
        expect(s.promptLines.map(l => l.lang)).toEqual(['kn']);
        expect(hasKannada(s.prompt)).toBe(true);
        expect(s.prompt).not.toMatch(/You just read/);
        expect(s.prompt).toContain('ದೇವ ಮೂಢತೆ');     // topic names in Kannada too (study-config.json)
        expect(s.prompt).toContain('ಲೋಕ ಮೂಢತೆ');
    });

    test('English only: unchanged', () => {
        const s = build(['en']);
        expect(s.prompt).toBe('You just read about Deva Moodhata. Can you explain how it differs from Loka Moodhata?');
        expect(s.promptLines).toHaveLength(1);
    });

    test('both: one whole sentence per language, in the selected order, and the single-string prompt is English', () => {
        const s = build(['kn', 'en']);
        expect(s.promptLines.map(l => l.lang)).toEqual(['kn', 'en']);
        expect(hasKannada(s.promptLines[0].text)).toBe(true);
        expect(s.promptLines[1].text).toBe(s.prompt);
        expect(hasKannada(s.prompt)).toBe(false);
    });

    test('recall: each language quotes the book\u2019s question in that language, never mixed', () => {
        const item = data.find(i => i.type === 'answer' && (i.references || []).some(r => model.index.itemById[r]?.type === 'question' && ['kn', 'en'].every(l => model.index.itemById[r].blocks.some(b => (b.content?.[l] || []).join('').trim()))));
        const s = Q.buildSuggestion(model, { kind: 'recall', itemId: item.id }, { langs: ['kn', 'en'] });
        const [kn, en] = s.promptLines;
        expect(kn.lang).toBe('kn');
        expect(hasKannada(kn.text)).toBe(true);
        expect(kn.text).not.toMatch(/A question from the book/);
        expect(hasKannada(en.text.replace(/\u201C[\s\S]*\u201D/, ''))).toBe(false);
        expect(en.text).toMatch(/^A question from the book: \u201C/);
        const knOnly = Q.buildSuggestion(model, { kind: 'recall', itemId: item.id }, { langs: ['kn'] });
        expect(knOnly.promptLines).toHaveLength(1);
        expect(hasKannada(knOnly.title)).toBe(true);
    });

    test('a language with no wording falls back to English', () => {
        expect(build(['xx']).prompt).toMatch(/^You just read about/);
    });
});

describe('descriptors', () => {
    test('a suggestion can be rebuilt from its descriptor (survives a reload)', () => {
        const id = blocksWithTag('Deva Moodhata')[0];
        const [s] = Q.suggestionsForRead(model, id, { readSet: everythingRead, langs: ['en'] });
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
