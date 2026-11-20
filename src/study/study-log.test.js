const { STUDY_LOG_KEY, loadStudyLog, saveStudyLog, recordResult, reviewList } = require('./study-log.js');

beforeEach(() => localStorage.clear());

test('starts empty, and unreadable or malformed storage is just empty', () => {
    expect(loadStudyLog(localStorage)).toEqual({});
    localStorage.setItem(STUDY_LOG_KEY, '{not json');
    expect(loadStudyLog(localStorage)).toEqual({});
    localStorage.setItem(STUDY_LOG_KEY, JSON.stringify([1, 2]));
    expect(loadStudyLog(localStorage)).toEqual({});
});

test('keeps only well-formed entries', () => {
    localStorage.setItem(STUDY_LOG_KEY, JSON.stringify({
        a: { status: 'got', desc: { kind: 'recall', itemId: 'x' } },
        b: { status: 'weird', desc: {} },
        c: { status: 'again' },
    }));
    expect(Object.keys(loadStudyLog(localStorage))).toEqual(['a']);
});

test('recordResult is pure, ignores unknown statuses, and moves a re-recorded id to the end', () => {
    const d = { kind: 'recall', itemId: 'x' };
    const one = recordResult({}, 'a', d, 'again');
    const two = recordResult(one, 'b', d, 'got');
    const three = recordResult(two, 'a', d, 'got');
    expect(one).toEqual({ a: { status: 'again', desc: d } });
    expect(Object.keys(three)).toEqual(['b', 'a']);
    expect(recordResult(one, 'a', d, 'bogus')).toBe(one);
});

test('round-trips through storage; reviewList is the "again" ones', () => {
    const d = { kind: 'recall', itemId: 'x' };
    let log = recordResult({}, 'a', d, 'again');
    log = recordResult(log, 'b', d, 'got');
    saveStudyLog(log, localStorage);
    const back = loadStudyLog(localStorage);
    expect(back).toEqual(log);
    expect(reviewList(back)).toEqual([{ id: 'a', desc: d }]);
});

test('stores only descriptors, never the book\u2019s text', () => {
    saveStudyLog(recordResult({}, 'a', { kind: 'compare', topics: ['A B', 'C D'] }, 'got'), localStorage);
    expect(localStorage.getItem(STUDY_LOG_KEY)).not.toMatch(/passage|text/i);
});
