// Tests for scripts/content-agent.js. The retrieval module is an ES module; babel-jest turns it into
// something require() can load (the same way src/ai/retrieval.test.js does).
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const retrieval = require('../src/ai/retrieval.js');
const { ID_PATTERN, hasId } = require('./new-id');
const { processDraft, renderReport, itemNeedsNum, queryFor, findFollowUpBlocks } = require('./content-agent');

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-11-18T12:34:56.789Z');
const run = (data, extra = {}) => processDraft(data, { retrieval, now: NOW, minScore: 0, relativeCut: 0.3, ...extra });

const clone = (x) => JSON.parse(JSON.stringify(x));
const block = (id, num, en, tags = []) => ({ ...(id ? { id } : {}), num, type: 'paragraph', content: { kn: [], en: [en] }, tags });

// A small existing book: a cover, an abhisheka Q&A, a shloka Q&A, and a photo insert.
const existing = () => [
    { id: 'cover2', num: 0, type: 'insert', hideId: true, blocks: [{ id: 'cvrblk', num: 1, type: 'images', images: [{ src: 'x.jpg' }], content: { kn: ['ಶೀರ್ಷಿಕೆ'], en: ['Book title'] } }] },
    { id: 'qabh22', num: 1, type: 'question', timestamp: '2026-06-01T10:00:00Z', references: null,
        blocks: [block('qabhb2', 1, 'Why do we perform abhisheka of the Jina idol with water and milk?', ['abhisheka'])] },
    { id: 'aabh33', type: 'answer', timestamp: '2026-06-01T10:05:00Z', references: ['qabh22'],
        blocks: [block('aabhb3', 1, 'Abhisheka is performed to remember the Janma Kalyanaka abhisheka by Indra on Mount Meru.', ['abhisheka', 'indra'])] },
    { id: 'phot44', num: 2, type: 'insert', timestamp: '2026-06-02T10:00:00Z',
        blocks: [{ id: 'photb4', num: 1, type: 'images', tags: ['abhisheka'], images: [{ src: 'abhisheka.jpg' }] }] },
    { id: 'qsha55', num: 3, type: 'question', timestamp: '2026-06-03T10:00:00Z', references: null,
        blocks: [block('qshab5', 1, 'What is the meaning of the Samantabhadra shloka about Deva Moodhata?', ['shloka', 'moodhata'])] },
];

const newQuestion = () => ({
    type: 'question',
    blocks: [block(null, 1, 'Can we use panchamruta for abhisheka, with milk and water?', ['abhisheka', 'panchamruta'])],
});
const newAnswer = () => ({
    type: 'answer',
    blocks: [block(null, 1, 'Yes, panchamruta abhisheka uses milk, curd, ghee, sugar and water; Indra did abhisheka on Mount Meru.', ['abhisheka'])],
});

describe('content agent: ids and timestamps', () => {
    test('gives every new item and block a well-formed, unique, permanent id', () => {
        const { data } = run([...existing(), newQuestion(), newAnswer()]);
        const all = data.flatMap((i) => [i, ...(i.blocks || [])]).map((x) => x.id);
        expect(all.every((id) => ID_PATTERN.test(id) || /^[a-z0-9]+$/.test(id))).toBe(true);
        expect(new Set(all).size).toBe(all.length);
        data.slice(-2).forEach((item) => {
            expect(ID_PATTERN.test(item.id)).toBe(true);
            item.blocks.forEach((b) => expect(ID_PATTERN.test(b.id)).toBe(true));
        });
    });

    test('never changes anything that already exists', () => {
        const before = existing();
        const { data } = run([...clone(before), newQuestion(), newAnswer()]);
        expect(data.slice(0, before.length)).toEqual(before);
    });

    test('stamps new items with a timestamp, but keeps one the author wrote', () => {
        const withStamp = { ...newAnswer(), timestamp: '2026-01-01T00:00:00Z' };
        const { data } = run([...existing(), newQuestion(), withStamp]);
        expect(data[5].timestamp).toBe('2026-11-18T12:34:56Z');
        expect(data[6].timestamp).toBe('2026-01-01T00:00:00Z');
    });

    test('puts timestamp after type, as in the rest of the file', () => {
        const { data } = run([...existing(), newQuestion()]);
        const keys = Object.keys(data[5]);
        expect(keys.indexOf('timestamp')).toBe(keys.indexOf('type') + 1);
        expect(keys[0]).toBe('id');
    });

    test('a new block in an existing item gets an id only: no timestamp, no cross-references', () => {
        const data = existing();
        data[2].blocks.push(block(null, 2, 'More about abhisheka and milk.', ['abhisheka']));
        const out = run(data);
        expect(ID_PATTERN.test(out.data[2].blocks[1].id)).toBe(true);
        expect(out.data[2].references).toEqual(['qabh22']);
        expect(out.data[2].timestamp).toBe('2026-06-01T10:05:00Z');
        expect(out.report.newItems).toHaveLength(0);
        expect(out.report.newBlocksInExistingItems).toHaveLength(1);
    });

    test('is idempotent: running again on its own output changes nothing', () => {
        const first = run([...existing(), newQuestion(), newAnswer()]);
        const second = run(first.data);
        expect(second.changed).toBe(false);
        expect(second.data).toEqual(first.data);
        expect(renderReport(second.report)).toMatch(/Nothing new to process/);
    });
});

describe('content agent: answer follows its question', () => {
    test('a new answer with no references right after a question is linked to it first', () => {
        const { data, report } = run([...existing(), newQuestion(), newAnswer()]);
        const [q, a] = data.slice(-2);
        expect(a.references[0]).toBe(q.id);
        expect(report.newItems[1].replyTo).toBe(q.id);
    });

    test('that makes the answer take the question\'s number', () => {
        const { itemNumber } = require('../src/core/blocks');
        const q = { ...newQuestion(), num: 4 };
        const { data } = run([...existing(), q, newAnswer()]);
        const byId = Object.fromEntries(data.map((i) => [i.id, i]));
        expect(itemNumber(data[6], byId)).toBe(4);
    });

    test('an answer that already has references keeps them (and the agent adds after them)', () => {
        const mine = { ...newAnswer(), references: ['qsha55'] };
        const { data } = run([...existing(), newQuestion(), mine]);
        expect(data[6].references[0]).toBe('qsha55');
    });

    test('a new answer that does not follow a question is not linked to anything by position', () => {
        const base = existing();
        const withOrphan = [...base.slice(0, 4), newAnswer(), base[4]];   // right after the photo insert
        const { report } = run(withOrphan);
        expect(report.newItems[0].replyTo).toBeNull();
    });
});

describe('content agent: follow-up answer (an answer that updates the answer above it)', () => {
    // an existing answer with three blocks on different subjects, then a new follow-up right below it
    const withBigAnswer = () => {
        const data = existing();
        data[2].blocks = [
            block('aabhb3', 1, 'Abhisheka with milk (ksheera) is described by Acharya Gunabhadra.', ['milk']),
            block('aabhb4', 2, 'The Panchamruta shloka lists milk, curd, ghee, sugar and water.', ['panchamruta']),
            block('aabhb5', 3, 'Neeram means plain water used on the idol.', ['water']),
        ];
        return data;
    };
    const followUp = (text = 'Acharya Vidyasagar on the Panchamruta shloka: devatas also do abhisheka.', tags = ['panchamruta']) =>
        ({ type: 'answer', blocks: [block(null, 1, text, tags)] });
    const base = () => withBigAnswer().slice(0, 3);        // cover, question, the big answer

    test('right below another answer it references that answer\'s blocks, not a question, and says so', () => {
        const { data, report } = run([...base(), followUp()]);
        const item = data[3];
        const parentBlocks = ['aabhb3', 'aabhb4', 'aabhb5'];
        expect(item.references.slice(0, 1).every((r) => parentBlocks.includes(r))).toBe(true);
        expect(item.references).not.toContain('qabh22');
        expect(item.references).not.toContain('aabh33');
        expect(report.newItems[0].replyTo).toBeNull();
        expect(report.newItems[0].followUpOf.id).toBe('aabh33');
    });

    test('picks the blocks it relates to, in the order they appear in the answer', () => {
        const { data, report } = run([...base(), followUp('The Panchamruta shloka: milk and water.', ['panchamruta', 'milk'])], { followUpBlocks: 2 });
        const order = ['aabhb3', 'aabhb4', 'aabhb5'];
        const linked = report.newItems[0].followUpOf.blocks.map((b) => b.blockId);
        expect(linked.length).toBeGreaterThan(0);
        expect(linked.length).toBeLessThanOrEqual(2);
        expect(linked).toContain('aabhb4');                                    // the Panchamruta shloka block
        expect(linked).toEqual([...linked].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
        expect(data[3].references.slice(0, linked.length)).toEqual(linked);    // they come first, cross-references after
    });

    test('at most followUpBlocks blocks, and at least one', () => {
        const one = run([...base(), followUp()], { followUpBlocks: 1 });
        expect(one.data[3].references.filter((r) => r.startsWith('aabhb'))).toHaveLength(1);
        const zero = run([...base(), followUp()], { followUpBlocks: 0 });
        expect(zero.data[3].references.filter((r) => r.startsWith('aabhb'))).toHaveLength(1);
    });

    test('with no word in common it still anchors to the first block of that answer', () => {
        const index = retrieval.createIndex(withBigAnswer());
        const picked = findFollowUpBlocks(index, retrieval, { blocks: [block('x', 1, 'zzzz qqqq', [])] }, withBigAnswer()[2], { relativeCut: 0.6, followUpBlocks: 3 });
        expect(picked.map((b) => b.blockId)).toEqual(['aabhb3']);
    });

    test('it needs its own num (it is not under a question), and the report says why', () => {
        const unnumbered = run([...base(), followUp()]);
        expect(unnumbered.report.newItems[0].needsNum).toBe(true);
        expect(renderReport(unnumbered.report)).toMatch(/needs its own `num`/);
        expect(renderReport(unnumbered.report)).toMatch(/follow-up to the answer right above it/);

        const numbered = run([...base(), { ...followUp(), num: 2 }]);
        expect(numbered.report.newItems[0].needsNum).toBe(false);
    });

    test('Q, A and a follow-up A2 all new in one push: A goes to Q, A2 goes to blocks of A', () => {
        const q = { ...newQuestion(), num: 4 };
        const a = newAnswer();
        a.blocks.push(block(null, 2, 'The Panchamruta shloka is quoted in Pratishta Shastra.', ['panchamruta']));
        const { data } = run([...existing(), q, a, followUp('The Panchamruta shloka: more.', ['panchamruta'])]);
        const [nq, na, nf] = data.slice(-3);
        expect(na.references[0]).toBe(nq.id);
        expect(nf.references.every((r) => na.blocks.some((b) => b.id === r) || r.length === 6)).toBe(true);
        expect(nf.references.some((r) => na.blocks.some((b) => b.id === r))).toBe(true);
    });

    test('references the author wrote on a follow-up are kept and nothing is linked by position', () => {
        const mine = { ...followUp(), references: ['aabhb5'] };
        const { data, report } = run([...base(), mine]);
        expect(data[3].references[0]).toBe('aabhb5');
        expect(report.newItems[0].followUpOf).toBeNull();
    });

    test('cross-references never repeat the answer being updated', () => {
        const { data } = run([...base(), followUp()]);
        const parentBlocks = ['aabhb3', 'aabhb4', 'aabhb5'];
        const refs = data[3].references;
        const parentRefs = refs.filter((r) => parentBlocks.includes(r));
        expect(parentRefs.length).toBeLessThanOrEqual(3);
        // anything after the follow-up links points at some OTHER item
        const extra = refs.filter((r) => !parentBlocks.includes(r));
        expect(extra).not.toContain('aabh33');
    });

    test('the result (with its own num) is valid against schema.json and resolves in the app', () => {
        const { buildBlockIndex, resolveReference, itemNumber } = require('../src/core/blocks');
        const ajv = new Ajv({ allErrors: true });
        addFormats(ajv);
        const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'schema.json'), 'utf8'));
        const { data } = run([...base(), { ...followUp(), num: 2 }]);
        expect(ajv.validate(schema, data)).toBe(true);
        const { blockById, itemById } = buildBlockIndex(data);
        data[3].references.forEach((r) => expect(resolveReference(r, blockById, itemById)).not.toBeNull());
        expect(itemNumber(data[3], itemById)).toBe(2);
    });

    test('is idempotent too', () => {
        const first = run([...base(), followUp()]);
        expect(run(first.data).changed).toBe(false);
    });

    test('on the real data: re-drafting the real follow-up answer anchors to blocks of the answer above it', () => {
        const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data.json'), 'utf8'));
        const i = real.findIndex((x) => x.id === 'z5xxer');
        expect(real[i - 1].type).toBe('answer');
        const draft = clone(real[i]);
        delete draft.id; delete draft.references; delete draft.timestamp;
        draft.blocks = draft.blocks.map(({ id, ...rest }) => rest);
        const { data, report } = processDraft([...clone(real.slice(0, i)), draft], { retrieval, now: NOW });
        const parentIds = real[i - 1].blocks.map((b) => b.id);
        const linked = report.newItems[0].followUpOf.blocks.map((b) => b.blockId);
        expect(linked.length).toBeGreaterThan(0);
        expect(linked.every((id) => parentIds.includes(id))).toBe(true);
        expect(data[i].references.slice(0, linked.length)).toEqual(linked);
        expect(report.newItems[0].needsNum).toBe(false);          // the real one has its own num (20)
    });
});

describe('content agent: cross-references', () => {
    test('a new abhisheka question points at the earlier abhisheka Q&A, never at the shloka one', () => {
        const { data, report } = run([...existing(), newQuestion()]);
        const refs = data[5].references;
        expect(refs.length).toBeGreaterThan(0);
        expect(refs).not.toContain('qsha55');
        expect(refs.every((r) => ['qabhb2', 'aabhb3'].includes(r))).toBe(true);
        expect(report.newItems[0].added.length).toBe(refs.length);
    });

    test('references point at BLOCK ids that resolve through the app\'s own resolver', () => {
        const { buildBlockIndex, resolveReference } = require('../src/core/blocks');
        const { data } = run([...existing(), newQuestion()]);
        const { blockById, itemById } = buildBlockIndex(data);
        data[5].references.forEach((r) => expect(resolveReference(r, blockById, itemById)).not.toBeNull());
    });

    test('never points at an insert (photo, blank or title page)', () => {
        const { data } = run([...existing(), newQuestion()]);
        expect(data[5].references).not.toContain('photb4');
        expect(data[5].references).not.toContain('phot44');
    });

    test('only points at EARLIER items, never at later ones', () => {
        const data = existing();
        // the new question sits before the abhisheka Q&A, so those are "later" and not allowed
        const out = run([data[0], newQuestion(), ...data.slice(1)]);
        expect(out.data[1].references).toBeUndefined();
    });

    test('at most maxRefs are added, and 0 turns cross-referencing off', () => {
        const many = run([...existing(), newQuestion()], { maxRefs: 1 });
        expect(many.data[5].references).toHaveLength(1);
        const none = run([...existing(), newQuestion()], { maxRefs: 0 });
        expect(none.data[5].references).toBeUndefined();
    });

    test('does not repeat something the author already referenced (block or item id)', () => {
        const mine = { ...newQuestion(), references: ['aabh33'] };
        const { data } = run([...existing(), mine]);
        expect(data[5].references[0]).toBe('aabh33');
        expect(data[5].references.filter((r) => r === 'aabh33' || r === 'aabhb3')).toHaveLength(1);
    });

    test('unrelated drafts get no cross-references when a score floor is set', () => {
        const idli = { type: 'question', blocks: [block(null, 1, 'How do I steam idli with rice and urad dal?', ['idli'])] };
        const { data, report } = run([...existing(), idli], { minScore: 50 });
        expect(data[5].references).toBeUndefined();
        expect(report.newItems[0].added).toEqual([]);
        expect(renderReport(report)).toMatch(/nothing earlier in the book matched/);
    });

    test('inserts never get cross-references', () => {
        const ins = { type: 'insert', blocks: [{ num: 1, type: 'images', tags: ['abhisheka'], images: [{ src: 'new.jpg' }] }] };
        const { data } = run([...existing(), ins]);
        expect(data[5].references).toBeUndefined();
    });

    test('puts `references` before `blocks` when the item had none, and keeps it where it was otherwise', () => {
        const { data } = run([...existing(), newQuestion()]);
        const keys = Object.keys(data[5]);
        expect(keys.indexOf('references')).toBe(keys.indexOf('blocks') - 1);
        const hadNull = { ...newQuestion(), references: null };
        const out = run([...existing(), hadNull]);
        expect(Array.isArray(out.data[5].references)).toBe(true);
    });

    test('the query uses text in every language plus the tags', () => {
        const q = { blocks: [{ content: { kn: ['ಅಭಿಷೇಕ'], en: ['milk'] }, tags: ['panchamruta'] }] };
        expect(queryFor(q)).toMatch(/ಅಭಿಷೇಕ/);
        expect(queryFor(q)).toMatch(/milk/);
        expect(queryFor(q)).toMatch(/panchamruta/);
    });
});

describe('content agent: report and numbers', () => {
    test('flags a new question with no num, and a new answer that follows a numbered question does not need one', () => {
        const unnumbered = run([...existing(), newQuestion(), newAnswer()]);
        expect(unnumbered.report.newItems[0].needsNum).toBe(true);
        expect(renderReport(unnumbered.report)).toMatch(/needs a `num`/);

        const numbered = run([...existing(), { ...newQuestion(), num: 4 }, newAnswer()]);
        expect(numbered.report.newItems[0].needsNum).toBe(false);
        expect(numbered.report.newItems[1].needsNum).toBe(false);
    });

    test('itemNeedsNum: an answer pointing at an unnumbered question still needs one', () => {
        const data = [{ id: 'q11111', type: 'question' }, { id: 'a11111', type: 'answer', references: ['q11111'] }];
        expect(itemNeedsNum(data[1], data)).toBe(true);
        data[0].num = 3;
        expect(itemNeedsNum(data[1], data)).toBe(false);
    });

    test('flags blocks without a num (the agent never invents numbers)', () => {
        const q = { type: 'question', blocks: [{ type: 'paragraph', content: { kn: [], en: ['Is abhisheka needed?'] } }] };
        const { data, report } = run([...existing(), q]);
        expect(data[5].blocks[0].num).toBeUndefined();
        expect(report.newItems[0].blocksNeedingNum).toEqual([data[5].blocks[0].id]);
    });

    test('the report lists the ids, the matches with their labels, and a review checklist', () => {
        const { report } = run([...existing(), { ...newQuestion(), num: 4 }]);
        const md = renderReport(report);
        expect(md).toMatch(/## Content pipeline agent/);
        expect(md).toMatch(/cross-references added/);
        expect(md).toMatch(/Ref: [A-Z]-\d+\.\d+/);
        expect(md).toMatch(/Before merging/);
    });
});

describe('content agent: result is valid data', () => {
    test('the processed data (once it has its nums) still matches schema.json', () => {
        const ajv = new Ajv({ allErrors: true });
        addFormats(ajv);
        const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'schema.json'), 'utf8'));
        const q = { ...newQuestion(), num: 4 };
        const { data } = run([...existing(), q, newAnswer()]);
        expect(ajv.validate(schema, data)).toBe(true);
    });
});

describe('content agent on the real data.json', () => {
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data.json'), 'utf8'));

    test('everything already has an id, so the agent changes nothing', () => {
        const entries = real.flatMap((i) => [i, ...(i.blocks || [])]);
        expect(entries.every(hasId)).toBe(true);
        const { changed, report } = processDraft(clone(real), { retrieval, now: NOW });
        expect(changed).toBe(false);
        expect(report.newItems).toHaveLength(0);
    });

    test('a re-drafted real question finds related content that was already in the book', () => {
        const i = real.findIndex((x) => x.type === 'question' && x.num === 13);
        const draft = clone(real[i]);
        delete draft.id; delete draft.num; delete draft.references; delete draft.timestamp;
        draft.blocks = draft.blocks.map(({ id, ...rest }) => rest);
        const { data, report } = processDraft([...clone(real.slice(0, i)), draft], { retrieval, now: NOW });
        const added = report.newItems[0].added;
        expect(added.length).toBeGreaterThan(0);
        // every added reference resolves to a block that exists, earlier in the book
        const ids = new Set(real.slice(0, i).flatMap((x) => (x.blocks || []).map((b) => b.id)));
        added.forEach((r) => expect(ids.has(r.blockId)).toBe(true));
        expect(data[i].references).toEqual(added.map((r) => r.blockId));
    });
});
