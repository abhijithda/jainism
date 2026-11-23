// Tests for scripts/typo-review.js and scripts/post-suggestions.js (the AI and GitHub are fakes).
const fs = require('fs');
const path = require('path');
const T = require('./typo-review');
const { fixFinalA } = require('./lib/translit');
const { onlyNew, postSuggestions } = require('./post-suggestions');

const ROOT = path.join(__dirname, '..');
const real = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'data.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const blk = (id, num, type, kn, en) => ({ id, num, type, content: { kn, en }, tags: [], videos: [], images: [] });
const book = (...blocks) => [{ id: 'itemq1', num: 1, type: 'question', blocks: [blk('bq0001', 1, 'paragraph', [], ['Why?'])] },
    { id: 'itema1', type: 'answer', references: ['itemq1'], blocks }];

/** A fake model that answers with fixed proposals. */
const fakeAi = (issues) => ({ available: true, json: jest.fn(async () => ({ issues })) });

describe('helpers', () => {
    test('edit distance counts code points', () => {
        expect(T.editDistance('abhisheka', 'abhisheka')).toBe(0);
        expect(T.editDistance('abhiseka', 'abhisheka')).toBe(1);
        expect(T.editDistance('ಅಭಿಷೇಕ', 'ಅಭಿಶೇಕ')).toBe(1);
    });
    test('the allowlist ignores comments and blank lines', () => {
        expect(T.loadAllowlist('# c\n\nPoojyapaada\n  ತೀರ್ಥಕರ  \n')).toEqual(['Poojyapaada', 'ತೀರ್ಥಕರ']);
    });
    test('the real allowlist file holds the spellings you chose', () => {
        const list = T.loadAllowlist(fs.readFileSync(path.join(ROOT, 'config', 'spelling-allowlist.txt'), 'utf8'));
        expect(list).toEqual(expect.arrayContaining(['Poojyapaada', 'ತೀರ್ಥಕರ']));
    });
});

describe('what is reviewed', () => {
    test('only new or changed blocks, unless all', () => {
        const base = book(blk('b00001', 1, 'paragraph', [], ['Same text.']), blk('b00002', 2, 'paragraph', [], ['Old text.']));
        const head = clone(base);
        head[1].blocks[1].content.en = ['Changed text.'];
        head[1].blocks.push(blk('b00003', 3, 'paragraph', [], ['New block.']));
        expect(T.changedBlocks(base, head).map((e) => e.block.id)).toEqual(['b00002', 'b00003']);
        expect(T.changedBlocks(base, head, { all: true })).toHaveLength(4);
    });
    test('lines carry the block label and whether they are verse', () => {
        const head = book(blk('b00001', 1, 'shloka', ['ಶ್ಲೋಕ'], ['shloka']), blk('b00002', 2, 'paragraph', [], ['text']));
        const lines = T.collectLines(T.changedBlocks([], head));
        expect(lines.filter((l) => l.blockId === 'b00001').every((l) => l.kind === 'verse' && l.label === 'S-1.1')).toBe(true);
        expect(lines.find((l) => l.blockId === 'b00002')).toMatchObject({ kind: 'prose', label: 'A-1.2', lang: 'en', index: 0 });
    });
});

describe('deciding what is clear', () => {
    const lines = [
        { key: 'p1|en|0', blockId: 'p1', label: 'A-1.1', lang: 'en', index: 0, kind: 'prose', text: 'We do abhiseka of Poojyapaada daily, abhiseka.' },
        { key: 'p2|kn|0', blockId: 'p2', label: 'A-1.2', lang: 'kn', index: 0, kind: 'prose', text: 'ಅಭಿಶೇಕ ಮಾಡುತ್ತಾರೆ' },
        { key: 'v1|kn|0', blockId: 'v1', label: 'S-1.1', lang: 'kn', index: 0, kind: 'verse', text: 'ಜಠತಿ ನ ಸಿದ್ಧತಿ' },
    ];
    const P = (key, old, nw, confidence = 'clear', reason = 'typo') => ({ key, old, new: nw, confidence, reason });
    test('a clear one-letter slip that occurs once is fixed', () => {
        const d = T.decide(lines, [P('p2|kn|0', 'ಅಭಿಶೇಕ', 'ಅಭಿಷೇಕ')], []);
        expect(d.fixes).toHaveLength(1);
    });
    test('the same typo several times in a line is one fix that corrects every place (not one run per place)', () => {
        const d = T.decide(lines, [P('p1|en|0', 'abhiseka', 'abhisheka')], []);
        expect(d.fixes).toHaveLength(1);
        expect(d.suggestions).toHaveLength(0);
    });
    test('"doubtful" from the model is only a suggestion, however small the change', () => {
        const d = T.decide(lines, [P('p2|kn|0', 'ಅಭಿಶೇಕ', 'ಅಭಿಷೇಕ', 'doubtful')], []);
        expect(d.fixes).toHaveLength(0);
        expect(d.suggestions).toHaveLength(1);
    });
    test('a big rewrite is only a suggestion, even if the model says clear', () => {
        const d = T.decide(lines, [P('p2|kn|0', 'ಮಾಡುತ್ತಾರೆ', 'ಮಾಡುತ್ತಿದ್ದಾರೆ')], []);
        expect(d.fixes).toHaveLength(0);
        expect(d.suggestions).toHaveLength(1);
    });
    test('Kannada gets a tighter limit than English', () => {
        const kn = T.decide(lines, [P('p2|kn|0', 'ಅಭಿಶೇಕ', 'ಅಭಿಷೇಕಂ!')], []);
        expect(kn.fixes).toHaveLength(0);
        const en = T.decide([{ ...lines[0], text: 'We do abhiseka.' }], [P('p1|en|0', 'abhiseka', 'abhisheka')], []);
        expect(en.fixes).toHaveLength(1);
    });
    test('shloka and mantra lines are never fixed or suggested: only flagged', () => {
        const d = T.decide(lines, [P('v1|kn|0', 'ಜಠತಿ', 'ಝಟಿತಿ')], []);
        expect(d.fixes).toHaveLength(0);
        expect(d.suggestions).toHaveLength(0);
        expect(d.flags).toHaveLength(1);
    });
    test('an allowlisted spelling is never flagged, in any case', () => {
        const d = T.decide([{ ...lines[0], text: 'Acharya poojyapaada said so.' }], [P('p1|en|0', 'poojyapaada', 'Pujyapada')], ['Poojyapaada']);
        expect(d.fixes.length + d.suggestions.length).toBe(0);
        expect(d.dropped[0].why).toMatch(/allowlisted/);
    });
    test('text that is not in the line, links, newlines and no-ops are dropped', () => {
        const d = T.decide(lines, [P('p2|kn|0', 'ಇಲ್ಲ', 'ಇದೆ'), P('p2|kn|0', 'ಅಭಿಶೇಕ', 'ಅಭಿಶೇಕ'), P('p2|kn|0', 'ಅಭಿಶೇಕ', 'a\nb'), P('nope|kn|0', 'x', 'y')], []);
        expect(d.dropped).toHaveLength(4);
        expect(d.fixes.length + d.suggestions.length).toBe(0);
    });
    test('a word inside a link is not touched', () => {
        const d = T.decide([{ ...lines[0], text: 'See https://example.com/abhiseka now' }], [P('p1|en|0', 'abhiseka', 'abhisheka')], []);
        expect(d.dropped[0].why).toMatch(/link/);
    });
});

describe('the whole review', () => {
    const base = book(blk('b00001', 1, 'paragraph', ['ಹಳೆಯ ಪಠ್ಯ'], ['Old text with a typo teh.']));
    const head = clone(base);
    head[1].blocks.push(
        blk('b00002', 2, 'paragraph', ['ಅಭಿಶೇಕ ಮಾಡುತ್ತಾರೆ'], ['We do the abhisheka  of the Jina daily.', 'Recieve the water, and keep it.']),
        blk('b00003', 3, 'shloka', ['ಜಠತಿ ನ ಸಿದ್ಧತಿ'], ['jathati na siddhati']),
    );
    const issues = [
        { key: 'b00002|kn|0', old: 'ಅಭಿಶೇಕ', new: 'ಅಭಿಷೇಕ', reason: 'wrong letter', confidence: 'clear' },
        { key: 'b00002|en|1', old: 'Recieve', new: 'Receive', reason: 'i before e', confidence: 'clear' },
        { key: 'b00002|en|1', old: 'keep', new: 'hold', reason: 'style', confidence: 'doubtful' },
        { key: 'b00003|kn|0', old: 'ಜಠತಿ', new: 'ಝಟಿತಿ', reason: 'maybe', confidence: 'clear' },
        { key: 'b00001|en|0', old: 'teh', new: 'the', reason: 'old, unchanged block', confidence: 'clear' },
    ];
    test('fixes clear typos, suggests the doubtful one, flags the shloka, leaves unchanged blocks and the shloka alone', async () => {
        const r = await T.reviewTypos(head, base, { ai: fakeAi(issues), allowlist: [] });
        const b2 = r.data[1].blocks[1];
        expect(b2.content.kn[0]).toBe('ಅಭಿಷೇಕ ಮಾಡುತ್ತಾರೆ');
        expect(b2.content.en[0]).toBe('We do the abhisheka of the Jina daily.');       // mechanical double space, no AI needed
        expect(b2.content.en[1]).toBe('Recieve the water, and keep it.'.replace('Recieve', 'Receive'));
        expect(r.data[1].blocks[2]).toEqual(head[1].blocks[2]);                         // shloka untouched
        expect(r.data[1].blocks[0]).toEqual(head[1].blocks[0]);                         // not in this branch's changes
        expect(r.applied.map((a) => a.old)).toEqual(expect.arrayContaining(['ಅಭಿಶೇಕ', 'Recieve']));
        expect(r.verses).toEqual([{ label: 'S-1.3', id: 'b00003', flagged: [expect.objectContaining({ old: 'ಜಠತಿ' })] }]);
    });
    test('the doubtful case becomes a suggestion on exactly the right line, with the whole JSON line replaced', async () => {
        const r = await T.reviewTypos(head, base, { ai: fakeAi(issues), allowlist: [] });
        expect(r.comments).toHaveLength(1);
        const c = r.comments[0];
        const lines = JSON.stringify(r.data, null, 2).split('\n');
        expect(lines[c.line - 1].trim()).toBe('"Receive the water, and keep it."');
        const indent = lines[c.line - 1].match(/^\s*/)[0];                      // the suggestion replaces the whole line, same indent
        expect(c.body).toContain('```suggestion\n' + indent + '"Receive the water, and hold it."\n```');
        expect(c.body).toMatch(/<!-- typo:[0-9a-f]{10} -->/);
        expect(c.side).toBe('RIGHT');
        expect(c.path).toBe('assets/data.json');
    });
    test('without a key only the double space is fixed, and the report says the AI check was skipped', async () => {
        const r = await T.reviewTypos(head, base, { ai: { available: false }, allowlist: [] });
        expect(r.applied).toHaveLength(1);
        expect(r.note).toMatch(/skipped/);
        expect(T.renderReport(r)).toMatch(/AI check was skipped/);
    });
    test('the report lists old, new and reason, and the shloka check', async () => {
        const r = await T.reviewTypos(head, base, { ai: fakeAi(issues), allowlist: [] });
        const md = T.renderReport(r);
        expect(md).toMatch(/\| A-1\.2 \(kn\) \| ಅಭಿಶೇಕ \| ಅಭಿಷೇಕ \| wrong letter \|/);
        expect(md).toMatch(/Shlokas and mantras: check against the source/);
        expect(md).toMatch(/Commit suggestion/);
    });
    test('a model failure does not break the review: the mechanical fix still happens and the note says what failed', async () => {
        const ai = { available: true, json: async () => { throw new Error('Gemini answered 400: bad model'); } };
        const r = await T.reviewTypos(head, base, { ai, allowlist: [] });
        expect(r.applied).toHaveLength(1);
        expect(r.note).toMatch(/bad model/);
    });
    test('on the real book: nothing changes when the model finds nothing', async () => {
        const data = real();
        const r = await T.reviewTypos(data, data, { ai: fakeAi([]), allowlist: [] });
        expect(r.changed).toBe(false);
        expect(r.data).toEqual(data);
    });
    test('on the real book with --all, a suggestion line number points at the line it is about', async () => {
        const data = real();
        const block = data.flatMap((i) => i.blocks).find((b) => b.type === 'paragraph' && b.content.en.length > 1);
        const line = block.content.en[1];
        const word = line.split(' ')[0];
        const ai = fakeAi([{ key: `${block.id}|en|1`, old: word, new: word + 'X', reason: 'test', confidence: 'doubtful' }]);
        const r = await T.reviewTypos(data, null, { ai, allowlist: [], all: true });
        const c = r.comments.find((x) => x.body.includes(word + 'X'));
        expect(c).toBeTruthy();
        expect(JSON.stringify(r.data, null, 2).split('\n')[c.line - 1].trim().replace(/,$/, '')).toBe(JSON.stringify(line));
    });
});

describe('posting suggestions to the Pull Request', () => {
    const c = (hash, line = 5) => ({ path: 'assets/data.json', line, side: 'RIGHT', hash, body: `x\n<!-- typo:${hash} -->` });
    test('onlyNew skips what is already on the PR', () => {
        expect(onlyNew([c('aaaaaaaaaa'), c('bbbbbbbbbb')], ['hello <!-- typo:aaaaaaaaaa -->']).map((x) => x.hash)).toEqual(['bbbbbbbbbb']);
    });
    function fakeGitHub({ rejectLines = [] } = {}) {
        const log = [];
        const fetchImpl = async (url, init = {}) => {
            const body = init.body ? JSON.parse(init.body) : null;
            log.push({ method: init.method, url, body });
            if (init.method === 'GET') return { ok: true, status: 200, json: async () => [{ body: 'old <!-- typo:cccccccccc -->' }] };
            if (url.endsWith('/reviews') && body.comments.some((x) => rejectLines.includes(x.line))) return { ok: false, status: 422, json: async () => ({ message: 'line not in diff' }) };
            return { ok: true, status: 200, json: async () => ({}) };
        };
        return { fetchImpl, log };
    }
    test('one review with every new suggestion, the commit id and no duplicates', async () => {
        const gh = fakeGitHub();
        const r = await postSuggestions({ fetchImpl: gh.fetchImpl, repo: 'me/site', pr: 7, sha: 'abc', token: 't', comments: [c('cccccccccc'), c('dddddddddd', 6)] });
        expect(r).toEqual({ posted: 1, skipped: 1, fallback: 0 });
        const post = gh.log.find((x) => x.method === 'POST');
        expect(post.url).toBe('https://api.github.com/repos/me/site/pulls/7/reviews');
        expect(post.body.commit_id).toBe('abc');
        expect(post.body.comments).toEqual([{ path: 'assets/data.json', line: 6, side: 'RIGHT', body: expect.any(String) }]);
    });
    test('a line GitHub refuses ends up in one ordinary comment, the others are still posted', async () => {
        const gh = fakeGitHub({ rejectLines: [9] });
        const r = await postSuggestions({ fetchImpl: gh.fetchImpl, repo: 'me/site', pr: 7, sha: 'abc', token: 't', comments: [c('dddddddddd', 6), c('eeeeeeeeee', 9)] });
        expect(r).toEqual({ posted: 1, skipped: 0, fallback: 1 });
        expect(gh.log.some((x) => x.url.endsWith('/issues/7/comments'))).toBe(true);
    });
});

describe('Kannada words inside English lines, and invisible characters', () => {
    const base = book();
    const head = clone(base);
    head[1].blocks.push(
        blk('m00001', 1, 'paragraph', ['5. ಚುಹಾವಣ : ಉಪ ಲೇಪನದಂತೆಯೇ ಆದರೆ ಕೇವಲ ಪಾದಗಳಿಗೆ ಮಾತ್ರ.'], ['5. ಚುಹಾವಣ : Similar to Upa lepana but only for feet.']),
        blk('m00002', 2, 'paragraph', ['6. \u2060ಪುಲ್ಲಾರೋಹಣ: ಪುಷ್ಪಾರೋಹಣ'], ['6. \u2060ಪುಲ್ಲಾರೋಹಣ: ಪುಷ್ಪಾರೋಹಣ - Aarohana/ putting flowers garland on pratima.']),
        blk('m00003', 3, 'paragraph', [], ['1. ಣವಣ / Navana  = Abhishekas']),
    );
    /** first call proposes; the round-trip call answers from `roundTrip` (latin -> what the model writes back) */
    const mixedAi = (proposals, roundTrip = {}) => ({
        available: true,
        json: jest.fn(async ({ system, prompt }) => {
            if (/Write each one back in Kannada/.test(system)) {
                const items = JSON.parse(prompt).items;
                return { items: items.map((it) => ({ id: it.id, kannada: roundTrip[it.latin] ?? '' })) };
            }
            if (/Kannada script inside the English line/.test(system)) return { issues: proposals };
            return { issues: [] };
        }),
    });
    const P1 = { key: 'm00001|en|0', old: 'ಚುಹಾವಣ', new: 'Chuhavana', reason: 'x', confidence: 'clear', score: 0.97 };
    const P2 = { key: 'm00002|en|0', old: 'ಪುಲ್ಲಾರೋಹಣ: ಪುಷ್ಪಾರೋಹಣ', new: 'Pullarohana: Pushparohana', reason: 'x', confidence: 'clear', score: 0.6 };
    const P3 = { key: 'm00003|en|0', old: 'ಣವಣ', new: 'Navana', reason: 'x', confidence: 'clear', score: 0.95 };
    const RT = { Chuhavana: 'ಚುಹಾವಣ', 'Pullarohana: Pushparohana': 'ಪುಲ್ಲಾರೋಹಣ: ಪುಷ್ಪಾರೋಹಣ', Navana: 'ನವನ' };

    test('sure and the round trip matches: written in Latin letters automatically, listed with its reason', async () => {
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P1], RT), allowlist: [] });
        expect(r.data[1].blocks[0].content.en[0]).toBe('5. Chuhavana : Similar to Upa lepana but only for feet.');
        expect(r.applied.filter((a) => /Kannada script/.test(a.reason)).map((a) => a.reason)).toEqual([expect.stringMatching(/round trip matches/)]);
        expect(r.data[1].blocks[0].content.kn[0]).toBe(head[1].blocks[0].content.kn[0]);
    });
    test('"ಉಪ ಲೇಪನ / Upa Lepana": two Kannada words next to the same two English words become the writer\'s own English, once', async () => {
        const h = clone(base);
        h[1].blocks.push(blk('m00004', 4, 'paragraph', ['2. ಉಪ ಲೇಪನ'], ['2. ಉಪ ಲೇಪನ / Upa Lepana']));
        const P4 = { key: 'm00004|en|0', old: 'ಉಪ ಲೇಪನ', new: 'Upa Lepana', reason: 'x', confidence: 'clear', score: 0.95 };
        const r = await T.reviewTypos(h, base, { ai: mixedAi([P4], { 'Upa Lepana': 'ಉಪ ಲೇಪನ' }), allowlist: [] });
        expect(r.data[1].blocks[0].content.en[0]).toBe('2. Upa Lepana');
        expect(T.renderReport(r)).toMatch(/the model proposed 1 change/);
    });
    test('a different English spelling next to the Kannada words stays a pair (the writer decides)', async () => {
        const h = clone(base);
        h[1].blocks.push(blk('m00005', 5, 'paragraph', [], ['2. ಉಪ ಲೇಪನ / Upalepana']));
        const P5 = { key: 'm00005|en|0', old: 'ಉಪ ಲೇಪನ', new: 'Upa Lepana', reason: 'x', confidence: 'clear', score: 0.95 };
        const r = await T.reviewTypos(h, base, { ai: mixedAi([P5], { 'Upa Lepana': 'ಉಪ ಲೇಪನ' }), allowlist: [] });
        expect(r.data[1].blocks[0].content.en[0]).toBe('2. Upa Lepana / Upalepana');
    });
    test('a low score is only a suggestion, even if the model says clear and the round trip matches', async () => {
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P2], RT), allowlist: [] });
        expect(r.data[1].blocks[1].content.en[0]).toContain('ಪುಲ್ಲಾರೋಹಣ');
        expect(r.comments.map((c) => c.body).join('')).toContain('Pullarohana: Pushparohana');
    });
    test('letters your equivalence list treats as the same (ಣ = ನ) no longer fail the round trip: automatic', async () => {
        const eq = T.loadEquivalents('ನ ಣ\nಲ ಳ');
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P3], RT), allowlist: [], equivalents: eq });
        expect(r.data[1].blocks[2].content.en[0]).toBe('1. Navana = Abhishekas');       // the duplicate "Navana / Navana" is not made
        expect(r.applied.map((a) => a.reason).join('|')).toMatch(/apart from letters your equivalence list/);
    });
    test('the equivalence list does not hide a real difference: ನವನ vs ಚುಹಾವಣ is still a suggestion', async () => {
        const eq = T.loadEquivalents('ನ ಣ');
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P1], { Chuhavana: 'ಮಹಾವೀರ' }), allowlist: [], equivalents: eq });
        expect(r.data[1].blocks[0].content.en[0]).toContain('ಚುಹಾವಣ');
        expect(r.comments).toHaveLength(1);
    });
    test('the real list: loads, folds ಣ/ನ, ಳ/ಲ, ಶ/ಷ/ಸ, vowel length and the aa sign, and still tells real words apart', () => {
        const eq = T.loadEquivalents(fs.readFileSync(path.join(ROOT, 'config', 'translit-equivalents.txt'), 'utf8'));
        const same = (a, b) => T.skeleton(a, eq) === T.skeleton(b, eq);
        expect(same('ಣವಣ', 'ನವನ')).toBe(true);
        expect(same('ಪುಷ್ಪಾರೋಹಣ', 'ಪುಷ್ಪರೊಹನ')).toBe(true);
        expect(same('ಅಭಿಷೇಕ', 'ಅಭಿಸೆಕ')).toBe(true);
        expect(same('ಚುಹಾವಣ', 'ಮಹಾವೀರ')).toBe(false);
        expect(same('ಕಮಲ', 'ಕರಲ')).toBe(false);
    });
    test('the list file: classes, comments, drop line', () => {
        const eq = T.loadEquivalents('# c\nನ ಣ  # trailing comment\ndrop: ಾ\n');
        expect(eq.map.get('ಣ')).toBe('ನ');
        expect(eq.drop.has('ಾ')).toBe(true);
    });
    test('a round trip that gives another spelling (ಣ vs ನ), with no list, is a suggestion that says so', async () => {
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P3], RT), allowlist: [] });
        expect(r.data[1].blocks[2].content.en[0]).toContain('ಣವಣ');
        const body = r.comments.map((c) => c.body).join('');
        expect(body).toContain('Navana');
        expect(body).toMatch(/not your spelling/);
    });
    test('"doubtful" from the model is a suggestion whatever the score', async () => {
        const r = await T.reviewTypos(head, base, { ai: mixedAi([{ ...P1, confidence: 'doubtful', score: 0.99 }], RT), allowlist: [] });
        expect(r.data[1].blocks[0].content.en[0]).toContain('ಚುಹಾವಣ');
        expect(r.comments).toHaveLength(1);
    });
    test('the threshold can be changed', async () => {
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P2], RT), allowlist: [], mixedAutoMin: 0.5 });
        expect(r.data[1].blocks[1].content.en[0]).toContain('Pullarohana: Pushparohana');
    });
    test('the Kannada line itself is never touched, and a proposal for a Kannada line is ignored', async () => {
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P1, { ...P1, key: 'm00001|kn|0' }], RT), allowlist: [] });
        expect(r.data[1].blocks[0].content.kn[0]).toBe(head[1].blocks[0].content.kn[0]);
        expect(r.applied.filter((a) => /Kannada script/.test(a.reason))).toHaveLength(1);
    });
    test('if the round-trip call fails the change stays a suggestion', async () => {
        const ai = mixedAi([P1], RT);
        const inner = ai.json;
        ai.json = jest.fn(async (req) => { if (/Write each one back/.test(req.system)) throw new Error('boom'); return inner(req); });
        const r = await T.reviewTypos(head, base, { ai, allowlist: [] });
        expect(r.data[1].blocks[0].content.en[0]).toContain('ಚುಹಾವಣ');
        expect(r.comments).toHaveLength(1);
        expect(r.note).toMatch(/boom/);
    });
    test('without a key nothing happens', async () => {
        const r = await T.reviewTypos(head, base, { ai: { available: false }, allowlist: [] });
        expect(r.comments).toHaveLength(0);
    });
    test('an allowlisted word is left alone', async () => {
        const r = await T.reviewTypos(head, base, { ai: mixedAi([P1], RT), allowlist: ['ಚುಹಾವಣ'] });
        expect(r.data[1].blocks[0].content.en[0]).toContain('ಚುಹಾವಣ');
        expect(r.comments).toHaveLength(0);
    });
    test('a word joiner pasted from Google Docs is removed automatically, in both languages; ZWJ/ZWNJ are kept', async () => {
        const r = await T.reviewTypos(head, base, { ai: { available: false }, allowlist: [] });
        expect(r.data[1].blocks[1].content.kn[0]).toBe('6. ಪುಲ್ಲಾರೋಹಣ: ಪುಷ್ಪಾರೋಹಣ');
        expect(r.data[1].blocks[1].content.en[0]).toBe('6. ಪುಲ್ಲಾರೋಹಣ: ಪುಷ್ಪಾರೋಹಣ - Aarohana/ putting flowers garland on pratima.');
        expect(r.applied.every((a) => ['invisible character', 'double space'].includes(a.reason))).toBe(true);
        const zwj = 'ಕ್\u200Dಷ';
        const keep = clone(base); keep[1].blocks.push(blk('m00009', 1, 'paragraph', [zwj], ['x']));
        const k = await T.reviewTypos(keep, base, { ai: { available: false }, allowlist: [] });
        expect(k.data[1].blocks[0].content.kn[0]).toBe(zwj);
    });
});

describe('final "a" and duplicates', () => {
    test('the Hindi-style ending is put back: abhishek -> abhisheka, ram -> rama; words that really end in a consonant are left', () => {
        expect(fixFinalA('ಅಭಿಷೇಕ', 'abhishek')).toEqual({ text: 'abhisheka', changed: true });
        expect(fixFinalA('ರಾಮ', 'Ram')).toEqual({ text: 'Rama', changed: true });
        expect(fixFinalA('ರಾಮ', 'Rama').changed).toBe(false);
        expect(fixFinalA('ಜಗತ್', 'jagat').changed).toBe(false);                       // ends in a virama: a real final consonant
        expect(fixFinalA('ಸಂ', 'sam').changed).toBe(false);                            // anusvara
        expect(fixFinalA('ಪುಷ್ಪ ಆರೋಹಣ', 'pushp arohan')).toEqual({ text: 'pushpa arohana', changed: true }); // both words end in a bare consonant
    });
    test('a phrase: each word is checked when the word counts match', () => {
        expect(fixFinalA('ಉಪ ಲೇಪನ', 'upa lepan').text).toBe('upa lepana');
        expect(fixFinalA('ಉಪ ಲೇಪನ', 'upalepan').text).toBe('upalepana');             // counts differ: last word only
    });
    const base = book();
    const mk = (kn, en) => { const h = clone(base); h[1].blocks.push(blk('d00001', 1, 'paragraph', [], [en])); return h; };
    const ai = (issue, back) => ({ available: true, json: jest.fn(async ({ system, prompt }) => {
        if (/Write each one back/.test(system)) return { items: JSON.parse(prompt).items.map((i) => ({ id: i.id, kannada: back })) };
        if (/Kannada script inside the English line/.test(system)) return { issues: [issue] };
        return { issues: [] };
    }) });
    const eq = T.loadEquivalents('ನ ಣ');
    test('the model\'s Hindi-style spelling is corrected before it is written', async () => {
        const head = mk(null, '1. ಅಭಿಷೇಕ of the Jina');
        const r = await T.reviewTypos(head, base, { ai: ai({ key: 'd00001|en|0', old: 'ಅಭಿಷೇಕ', new: 'abhishek', confidence: 'clear', score: 0.97 }, 'ಅಭಿಷೇಕ'), allowlist: [], equivalents: eq });
        expect(r.data[1].blocks[0].content.en[0]).toBe('1. abhisheka of the Jina');
        expect(r.applied[0].reason).toMatch(/final "a" put back/);
    });
    test('Kannada word + the same English word (right or left, with / - = or brackets): one word is kept, as the writer typed it', async () => {
        for (const [line, want] of [
            ['2. ಚುಹಾವಣ / Chuhavana : Similar to upa lepana.', '2. Chuhavana : Similar to upa lepana.'],
            ['2. ಚುಹಾವಣ (chuhavana) is only for feet.', '2. chuhavana is only for feet.'],
            ['2. Chuhavana - ಚುಹಾವಣ is only for feet.', '2. Chuhavana is only for feet.'],
        ]) {
            const r = await T.reviewTypos(mk(null, line), base, { ai: ai({ key: 'd00001|en|0', old: 'ಚುಹಾವಣ', new: 'Chuhavana', confidence: 'clear', score: 0.97 }, 'ಚುಹಾವಣ'), allowlist: [], equivalents: eq });
            expect(r.data[1].blocks[0].content.en[0]).toBe(want);
        }
    });
    test('a different English spelling next to it is NOT treated as a duplicate: both stay', async () => {
        const r = await T.reviewTypos(mk(null, '2. ಚುಹಾವಣ / Chuhavan : feet.'), base, { ai: ai({ key: 'd00001|en|0', old: 'ಚುಹಾವಣ', new: 'Chuhavana', confidence: 'clear', score: 0.97 }, 'ಚುಹಾವಣ'), allowlist: [], equivalents: eq });
        expect(r.data[1].blocks[0].content.en[0]).toBe('2. Chuhavana / Chuhavan : feet.');
    });
    test('not sure: the duplicate is dropped only in the suggestion, not on its own', async () => {
        const r = await T.reviewTypos(mk(null, '2. ಚುಹಾವಣ / Chuhavana : feet.'), base, { ai: ai({ key: 'd00001|en|0', old: 'ಚುಹಾವಣ', new: 'Chuhavana', confidence: 'doubtful', score: 0.99 }, 'ಚುಹಾವಣ'), allowlist: [], equivalents: eq });
        expect(r.data[1].blocks[0].content.en[0]).toContain('ಚುಹಾವಣ');
        expect(r.comments[0].body).toContain('"2. Chuhavana : feet."');
    });
    test('the same English word typed twice by the writer is only a suggestion', async () => {
        const r = await T.reviewTypos(mk(null, '3. Navana / navana = Abhishekas'), base, { ai: { available: false }, allowlist: [] });
        expect(r.data[1].blocks[0].content.en[0]).toBe('3. Navana / navana = Abhishekas');
        expect(r.applied).toHaveLength(0);
        expect(T.duplicatePairIssues({ key: 'k', lang: 'en', text: 'a bit-by-bit and step-by-step plan, so-so' })).toEqual([]);
    });
});

describe('the spelling style reaches every prompt that writes English', () => {
    test('typo, mixed-script, translation and video prompts all say: keep the final a', () => {
        const fs2 = require('fs');
        for (const f of ['typo-review.js', 'notes-to-blocks.js', 'video-followup.js']) {
            const src = fs2.readFileSync(path.join(__dirname, f), 'utf8');
            expect(src).toMatch(/TRANSLIT_STYLE|final "a"/);
        }
        const { TRANSLIT_STYLE } = require('./lib/translit');
        expect(TRANSLIT_STYLE).toMatch(/abhisheka not abhishek, Rama not Ram/);
    });
});

describe('a typo is found as a whole word, never inside a longer word', () => {
    const LINE = '5. Chuhavana : Similar to Upa lepana but only for feet. In upa lepana, chandana lepana is done for entire pratima. In Chuhavana, chandan lepana is done only for feet.';

    test('"chandan" is the word at the end, not the first letters of "chandana" (which made "chandanaa")', () => {
        const r = T.applyToLine(LINE, [{ old: 'chandan', new: 'chandana', reason: 'x' }]);
        expect(r.text).toContain('In upa lepana, chandana lepana is done for entire');
        expect(r.text).toContain('In Chuhavana, chandana lepana is done only for feet.');
        expect(r.text).not.toContain('chandanaa');
        expect(r.applied).toHaveLength(1);
    });

    test('a word that only exists inside longer words is not found at all', () => {
        expect(T.locate('chandana lepana', 'chandan')).toBe(-1);
        expect(T.applyToLine('chandana lepana', [{ old: 'chandan', new: 'chandana' }])).toMatchObject({ text: 'chandana lepana', applied: [], left: [expect.anything()] });
    });

    test('Kannada words too, and punctuation next to a word does not count as a letter', () => {
        expect(T.locate('ನೀರಿನ್ನುಗಳು ನೀರಿನ್ನು', 'ನೀರಿನ್ನು')).toBe('ನೀರಿನ್ನುಗಳು '.length);
        expect(T.locate('(sugandint), x', 'sugandint')).toBe(1);
        expect(T.locate('say sugandint.', 'sugandint')).toBe(4);
    });

    test('a span with its own context characters (double space) still matches inside words', () => {
        const r = T.applyToLine('Navana  = Abhishekas', [{ old: 'a  =', new: 'a =', reason: 'double space', exact: true }]);
        expect(r.text).toBe('Navana = Abhishekas');
    });

    test('the one-click suggestion puts the fix on the right "chandan"', async () => {
        const base = book();
        const head = clone(base);
        head[1].blocks.push(blk('m00007', 1, 'paragraph', [], [LINE]));
        const issue = { key: 'm00007|en|0', old: 'chandan', new: 'chandana', reason: "Sanskrit words keep the final 'a'", confidence: 'doubtful' };
        const r = await T.reviewTypos(head, base, { ai: fakeAi([issue]), allowlist: [] });
        expect(r.comments).toHaveLength(1);
        expect(r.comments[0].body).toContain('In upa lepana, chandana lepana is done for entire');
        expect(r.comments[0].body).toContain('In Chuhavana, chandana lepana is done only for feet.');
        expect(r.comments[0].body).not.toContain('chandanaa');
    });
});

describe('the same typo several times in one line is fixed in one run', () => {
    test('all whole-word places are corrected, the count is reported, and words that merely contain it are left alone', () => {
        const text = 'sugandint dravyo, sugandint jal, sugandint; sugandints stay; (sugandint)';
        const change = { old: 'sugandint', new: 'sugandhit', reason: 'x' };
        const r = T.applyToLine(text, [change]);
        expect(r.text).toBe('sugandhit dravyo, sugandhit jal, sugandhit; sugandints stay; (sugandhit)');
        expect(r.applied).toEqual([expect.objectContaining({ count: 4 })]);
    });

    test('ten identical typos: one run, one fix, ten corrections', async () => {
        const base = book();
        const head = clone(base);
        const line = Array.from({ length: 10 }, (_, i) => `abhiseka ${i}`).join(' ');
        head[1].blocks.push(blk('m00009', 1, 'paragraph', [], [line]));
        const issue = { key: 'm00009|en|0', old: 'abhiseka', new: 'abhisheka', reason: 'spelling', confidence: 'clear' };
        const r = await T.reviewTypos(head, base, { ai: fakeAi([issue]), allowlist: [] });
        expect(r.data[1].blocks[0].content.en[0]).toBe(Array.from({ length: 10 }, (_, i) => `abhisheka ${i}`).join(' '));
        expect(r.applied).toHaveLength(1);
        expect(T.renderReport(r)).toMatch(/10 places in this line/);
    });

    test('a doubtful typo repeated in a line is ONE suggestion that fixes every place', async () => {
        const base = book();
        const head = clone(base);
        head[1].blocks.push(blk('m00008', 1, 'paragraph', [], ['chandan lepana, chandan lepana, chandana lepana']));
        const issue = { key: 'm00008|en|0', old: 'chandan', new: 'chandana', reason: 'x', confidence: 'doubtful' };
        const r = await T.reviewTypos(head, base, { ai: fakeAi([issue]), allowlist: [] });
        expect(r.comments).toHaveLength(1);
        expect(r.comments[0].body).toContain('chandana lepana, chandana lepana, chandana lepana');
        expect(r.comments[0].body).toContain('2 places in this line');
        expect(r.comments[0].body).not.toContain('chandanaa');
    });

    test('a protected spelling anywhere among the places stops the change (the allowlist wins)', async () => {
        const base = book();
        const head = clone(base);
        head[1].blocks.push(blk('m00010', 1, 'paragraph', [], ['abhiseka and abhiseka']));
        const issue = { key: 'm00010|en|0', old: 'abhiseka', new: 'abhisheka', reason: 'spelling', confidence: 'clear' };
        const r = await T.reviewTypos(head, base, { ai: fakeAi([issue]), allowlist: ['abhiseka'] });
        expect(r.data[1].blocks[0].content.en[0]).toBe('abhiseka and abhiseka');
    });
});

describe('Kannada: a change that only swaps a short vowel for a long one is a suggestion', () => {
    const kn = (text) => [{ key: 'k1|kn|0', blockId: 'k1', label: 'A-3.3', lang: 'kn', index: 0, text, kind: 'prose' }];
    const P2 = (old, nw, conf = 'clear') => ({ key: 'k1|kn|0', old, new: nw, reason: 'x', confidence: conf });

    test('ಬಂದರು → ಬಂದರೂ (both real words) is only suggested, with a note why', () => {
        const d = T.decide(kn('ಅವರು ಮನೆಗೆ ಬಂದರು'), [P2('ಬಂದರು', 'ಬಂದರೂ')], []);
        expect(d.fixes).toHaveLength(0);
        expect(d.suggestions).toHaveLength(1);
        expect(d.suggestions[0].reason).toMatch(/only the vowel length changes/);
    });
    test('other clear Kannada typos are still fixed automatically', () => {
        expect(T.decide(kn('ಮಾಡುಕೊಳ್ಳಲು'), [P2('ಮಾಡುಕೊಳ್ಳಲು', 'ಮಾಡಿಕೊಳ್ಳಲು')], []).fixes).toHaveLength(1);   // ು to ಿ is not a length pair
        expect(T.decide(kn('ಸಾದ್ಯ'), [P2('ಸಾದ್ಯ', 'ಸಾಧ್ಯ')], []).fixes).toHaveLength(1);
        expect(T.decide(kn('ಮಾಹಾ'), [P2('ಮಾಹಾ', 'ಮಹಾ')], []).fixes).toHaveLength(1);
    });
    test('the pairs it knows', () => {
        expect(T.vowelLengthOnly('ಬಂದರು', 'ಬಂದರೂ')).toBe(true);
        expect(T.vowelLengthOnly('ಪಿತ', 'ಪೀತ')).toBe(true);
        expect(T.vowelLengthOnly('ಕೆರೆ', 'ಕೇರೆ')).toBe(true);
        expect(T.vowelLengthOnly('ಒಂದು', 'ಓಂದು')).toBe(true);
        expect(T.vowelLengthOnly('ಸಾದ್ಯ', 'ಸಾಧ್ಯ')).toBe(false);
        expect(T.vowelLengthOnly('same', 'same')).toBe(false);
    });
    test('English is not affected', () => {
        const en = [{ key: 'k1|en|0', blockId: 'k1', label: 'A-3.3', lang: 'en', index: 0, text: 'recieve it', kind: 'prose' }];
        expect(T.decide(en, [{ key: 'k1|en|0', old: 'recieve', new: 'receive', reason: 'x', confidence: 'clear' }], []).fixes).toHaveLength(1);
    });
});

describe('the report says which part the AI could not check', () => {
    test('a failed part is counted and the block labels are named', async () => {
        const base = book();
        const head = clone(base);
        const many = Array.from({ length: 130 }, (_, i) => `plain English line number ${i}`);
        head[1].blocks.push(blk('m00020', 1, 'paragraph', [], many));
        let calls = 0;
        const ai = { available: true, json: async () => { calls++; if (calls === 2) { const e = new Error('Gemini answered 429 (busy or rate-limited)'); e.unavailable = true; throw e; } return { issues: [] }; } };
        const r = await T.reviewTypos(head, base, { ai, allowlist: [] });
        expect(r.note).toMatch(/failed for part of the text \(1 of 3 part\(s\); not checked: [A-Z]-\d+\.\d+/);
        expect(T.renderReport(r)).toMatch(/not checked/);
    });
    test('mixed-script wording: when the check did not run it says so instead of promising Latin letters', () => {
        const r = { data: [], changed: false, applied: [], comments: [], verses: [], dropped: [], note: 'the Kannada-in-English check failed in part: x', mixedFound: 3, mixedProposed: 0, summary: { lines: 5, blocks: 2, whole: true }, notApplied: [] };
        const text = T.renderReport(r);
        expect(text).toMatch(/proposed 0 change\(s\)\. The check did not finish/);
        expect(text).not.toMatch(/written in Latin letters above/);
    });
});

