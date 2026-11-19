const { tokenize } = require('./retrieval');

describe('Devanagari (Hindi, Sanskrit, Marathi) text is searchable', () => {
    test('words are cut into character trigrams, like Kannada, so vowel signs are not lost', () => {
        expect(tokenize('पूजा')).toEqual(['पूज', 'ूजा']);
        expect(tokenize('शासन देवता').length).toBeGreaterThan(2);
    });

    test('two forms of one word share trigrams (a suffix does not hide the stem)', () => {
        const a = new Set(tokenize('देवताओं'));
        expect(tokenize('देवता').every(t => a.has(t))).toBe(true);
    });

    test('Kannada and Latin are unchanged', () => {
        expect(tokenize('ಅಭಿಷೇಕ')).toEqual(['ಅಭಿ', 'ಭಿಷ', 'ಿಷೇ', 'ಷೇಕ']);
        expect(tokenize('Abhisheka')).toEqual(['abisek']);
    });
});
