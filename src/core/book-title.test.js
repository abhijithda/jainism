const { getBookTitle, joinTitle, bookHeaderTitle, titleSlug } = require('./book-title');

const cover = content => [{ id: 'c', type: 'insert', blocks: [{ id: 'cb', type: 'images', content }] }];

describe('getBookTitle', () => {
    test('first non-empty line is the title, the next the subtitle, per language', () => {
        const t = getBookTitle(cover({ kn: ['  ಶೀರ್ಷಿಕೆ ', '', 'ಉಪಶೀರ್ಷಿಕೆ'], en: ['Title', 'Subtitle', 'ignored'] }));
        expect(t).toEqual({ kn: { title: 'ಶೀರ್ಷಿಕೆ', subtitle: 'ಉಪಶೀರ್ಷಿಕೆ' }, en: { title: 'Title', subtitle: 'Subtitle' } });
    });
    test('title only: the subtitle is empty', () => {
        expect(getBookTitle(cover({ kn: ['ಶೀ'], en: ['T'] })).en).toEqual({ title: 'T', subtitle: '' });
    });
    test('no cover, odd content or no data: empty strings, never throws', () => {
        const empty = { kn: { title: '', subtitle: '' }, en: { title: '', subtitle: '' } };
        expect(getBookTitle(undefined)).toEqual(empty);
        expect(getBookTitle([])).toEqual(empty);
        expect(getBookTitle([{ type: 'question', blocks: [{ content: { en: ['x'] } }] }])).toEqual(empty);
        expect(getBookTitle(cover({ kn: 'not a list', en: [null, 5] })).en.title).toBe('5');
    });
    test('the real data.json has a cover title and subtitle in both languages', () => {
        const t = getBookTitle(require('../../assets/data.json'));
        ['kn', 'en'].forEach(l => { expect(t[l].title).not.toBe(''); expect(t[l].subtitle).not.toBe(''); });
    });
});

describe('title forms', () => {
    const t = { kn: { title: 'ಜೈನ ಧರ್ಮ — ಪ್ರಶ್ನೋತ್ತರ' }, en: { title: 'Jainism F.A.Q.s' } };
    test('joinTitle is "Kannada | English", skipping a missing language', () => {
        expect(joinTitle(t)).toBe('ಜೈನ ಧರ್ಮ — ಪ್ರಶ್ನೋತ್ತರ | Jainism F.A.Q.s');
        expect(joinTitle({ kn: { title: '' }, en: { title: 'Only' } })).toBe('Only');
    });
    test('bookHeaderTitle has Kannada first, English last and em spaces between', () => {
        const h = bookHeaderTitle(t);
        expect(h.startsWith('ಜೈನ ಧರ್ಮ — ಪ್ರಶ್ನೋತ್ತರ ')).toBe(true);
        expect(h.endsWith(' Jainism F.A.Q.s')).toBe(true);
        expect(h).toMatch(/\u2003{4,}/);
    });
    test('a longer title gets fewer em spaces, a shorter one more (about the same total width)', () => {
        const count = x => (bookHeaderTitle(x).match(/\u2003/g) || []).length;
        const long = { kn: { title: 'ಕ'.repeat(30) }, en: { title: 'L'.repeat(40) } };
        const short = { kn: { title: 'ಕ'.repeat(10) }, en: { title: 'S'.repeat(10) } };
        expect(count(short)).toBeGreaterThan(count(long));
    });
    test('bookHeaderTitle falls back to whichever language exists', () => {
        expect(bookHeaderTitle({ kn: { title: '' }, en: { title: 'E' } })).toBe('E');
    });
    test('titleSlug makes file-name parts', () => {
        expect(titleSlug('Jainism F.A.Q.s')).toBe('Jainism-FAQs');
        expect(titleSlug('Jina Pooja Questions & Answers')).toBe('Jina-Pooja-Questions-and-Answers');
        expect(titleSlug('  Śāstra  Q&A! ')).toBe('Sastra-Q-and-A');
        expect(titleSlug('')).toBe('');
    });
});
