const { KNOWN_LANGS, LANG_CODES, MAX_ACTIVE_LANGS, limitLangs, activeLangCodes } = require('./langs');

describe('LANG_CODES', () => {
    test('is the registry\'s codes, in registry order', () => {
        expect(LANG_CODES).toEqual(KNOWN_LANGS.map(l => l.code));
        expect(LANG_CODES).toEqual(expect.arrayContaining(['kn', 'en', 'hi']));
    });

    test('Kannada and English come first (they are the site default)', () => {
        expect(LANG_CODES.slice(0, 2)).toEqual(['kn', 'en']);
    });

    test('Hindi is shown in Devanagari', () => {
        expect(KNOWN_LANGS.find(l => l.code === 'hi')).toEqual({ code: 'hi', label: 'हिन्दी', name: 'Hindi' });
    });
});

describe('limitLangs', () => {
    test('at most MAX_ACTIVE_LANGS (two) languages', () => {
        expect(MAX_ACTIVE_LANGS).toBe(2);
        expect(limitLangs(['kn', 'en', 'hi'])).toEqual(['kn', 'en']);
    });

    test('keeps registry order, drops unknown codes and duplicates', () => {
        expect(limitLangs(['hi', 'kn'])).toEqual(['kn', 'hi']);
        expect(limitLangs(['fr', 'en', 'en'])).toEqual(['en']);
    });

    test('anything that is not a list selects nothing', () => {
        expect(limitLangs(undefined)).toEqual([]);
        expect(limitLangs('kn')).toEqual([]);
    });
});

describe('activeLangCodes', () => {
    test("'all' selects every known language, in registry order", () => {
        expect(activeLangCodes('all')).toEqual(LANG_CODES);
    });

    test('a single code selects just that language', () => {
        expect(activeLangCodes('kn')).toEqual(['kn']);
        expect(activeLangCodes('en')).toEqual(['en']);
        expect(activeLangCodes('hi')).toEqual(['hi']);
    });

    test('a list selects exactly its languages, in registry order', () => {
        expect(activeLangCodes(['hi', 'kn'])).toEqual(['kn', 'hi']);
        expect(activeLangCodes(['en'])).toEqual(['en']);
        expect(activeLangCodes(['xx'])).toEqual([]);
    });

    test('an unknown code selects nothing; no argument means all', () => {
        expect(activeLangCodes('xx')).toEqual([]);
        expect(activeLangCodes()).toEqual(LANG_CODES);
    });
});
