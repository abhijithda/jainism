/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');
const retrieval = require('../src/ai/retrieval.js');
const study = require('../src/study/study-questions.js');
const { TOPIC_NAMES } = require('../src/study/topic-names.js');
const { buildReport } = require('./study-report.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data.json'), 'utf8'));
const run = names => buildReport({ data, retrieval, study, names });

test('lists each comparison once, with the ones the book names together marked', () => {
    const { pairs, markdown } = run(TOPIC_NAMES);
    expect(pairs.length).toBeGreaterThan(5);
    const keys = pairs.map(p => [p.a, p.b].map(x => x.toLowerCase()).sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    expect(markdown).toMatch(/Deva Moodhata <-> Loka Moodhata {2}\(named together in the book\)/);
    expect(markdown).not.toMatch(/Chakreshwari Yakshi|Vamsha Purana/);
});

test('topics without a Kannada name are listed with the book\u2019s own Kannada line to copy from', () => {
    const { missing, markdown } = run({});
    expect(missing.map(m => m.topic)).toContain('Kali Devi');
    const kali = missing.find(m => m.topic === 'Kali Devi');
    expect(kali.hint).toMatch(/^[A-Z]-\d+\.\d+: .*[\u0C80-\u0CFF]/);
    expect(markdown).toMatch(/topics without a Kannada name/);
});

test('a name that matches no topic is flagged as stale', () => {
    const { stale } = run({ ...TOPIC_NAMES, 'No Such Topic': { kn: '\u0C85' } });
    expect(stale).toEqual(['No Such Topic']);
});

test('with every name present, says so', () => {
    const names = Object.fromEntries(run({}).missing.map(m => [m.topic, { kn: '\u0C85' }]));
    const { missing, markdown } = run(names);
    expect(missing).toEqual([]);
    expect(markdown).toMatch(/Every topic in a comparison has a Kannada name/);
});
