const { searchBlocks, excerptAround, MIN_QUERY_LENGTH } = require('./search');

const data = [
    { id: 'ins', type: 'insert', blocks: [{ id: 'ins_b', type: 'images', content: { en: ['Devata picture'] } }] },
    {
        id: 'q_001', type: 'qa',
        blocks: [
            { id: 'q_001_b_1', type: 'question', content: { kn: ['ದೇವತೆ'], en: ['Are all Devatas equal to Jinendra?'] } },
            { id: 'q_001_b_2', type: 'answer', content: { en: ['No. Worship of a devata for greed is not right.', 'Second line'] } },
        ],
    },
    { id: 'q_002', type: 'qa', blocks: [{ id: 'q_002_b_1', type: 'question', content: { en: ['What is Daana?'] } }] },
];

describe('excerptAround', () => {
    test('splits the line around the hit and marks what was cut off', () => {
        const line = 'a'.repeat(40) + 'HIT' + 'b'.repeat(80);
        const e = excerptAround(line, 40, 3);
        expect(e.hit).toBe('HIT');
        expect(e.before.startsWith('…')).toBe(true);
        expect(e.after.endsWith('…')).toBe(true);
    });
    test('a short line has no ellipsis', () => {
        expect(excerptAround('hello world', 6, 5)).toEqual({ before: 'hello ', hit: 'world', after: '' });
    });
});

describe('searchBlocks', () => {
    test('finds blocks case-insensitively, in book order, and counts every match', () => {
        const r = searchBlocks(data, 'DEVATA', ['en'], 5);
        expect(r.total).toBe(2);
        expect(r.results.map(x => x.blockId)).toEqual(['q_001_b_1', 'q_001_b_2']);
        expect(r.results[0].hit).toBe('Devata');
    });

    test('skips insert pages (pictures) and gives each block a display label', () => {
        const r = searchBlocks(data, 'picture', ['en']);
        expect(r.total).toBe(0);
        expect(searchBlocks(data, 'Daana', ['en']).results[0].label).toMatch(/^Q-/);
    });

    test('limit caps the list but not the total', () => {
        const r = searchBlocks(data, 'a', ['en'], 1);   // one letter: too short, nothing
        expect(r).toEqual({ total: 0, results: [] });
        const two = searchBlocks(data, 'de', ['en'], 1);
        expect(two.results).toHaveLength(1);
        expect(two.total).toBeGreaterThan(1);
    });

    test('looks in the reader\'s languages first, then the rest', () => {
        // "ದೇವತೆ" exists only in Kannada: found even when only English is on.
        expect(searchBlocks(data, 'ದೇವತೆ', ['en']).total).toBe(1);
        // When both match, the active language wins the excerpt.
        const r = searchBlocks([{ id: 'x', type: 'qa', blocks: [{ id: 'x_b', type: 'note', content: { kn: ['abc dana'], en: ['english dana'] } }] }], 'dana', ['en']);
        expect(r.results[0].before).toBe('english ');
    });

    test('too-short or missing input returns nothing', () => {
        expect(MIN_QUERY_LENGTH).toBe(2);
        expect(searchBlocks(data, '', ['en'])).toEqual({ total: 0, results: [] });
        expect(searchBlocks(null, 'devata', ['en'])).toEqual({ total: 0, results: [] });
    });
});
