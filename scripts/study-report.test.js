/**
 * @jest-environment node
 */
const fs = require('fs');
const path = require('path');
const retrieval = require('../src/ai/retrieval.js');
const study = require('../src/study/study-questions.js');
const { createStudyConfig } = require('../src/study/study-config.js');
const { buildReport } = require('./study-report.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data.json'), 'utf8'));
const bookConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'study-config.json'), 'utf8'));
const run = (raw = bookConfig, lang) => buildReport({ data, retrieval, study, config: createStudyConfig(raw), lang });

test('lists each comparison once, with the ones the book names together marked', () => {
    const { pairs, markdown } = run();
    expect(pairs.length).toBeGreaterThan(5);
    const keys = pairs.map(p => [p.a, p.b].map(x => x.toLowerCase()).sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    expect(markdown).toMatch(/Deva Moodhata <-> Loka Moodhata {2}\(named together in the book\)/);
    expect(markdown).toMatch(/(Chakreshwari Yakshi <-> Gomukha Yaksha|Gomukha Yaksha <-> Chakreshwari Yakshi)/);
    expect(markdown).not.toMatch(/Vamsha Purana|Govadana|<-> Yaksha Yakshi|Yaksha Yakshi <->/);
});

test('topics without a Kannada name are listed with the book\u2019s own Kannada line to copy from', () => {
    const { missing, markdown } = run({});
    expect(missing.map(m => m.topic)).toContain('Kali Devi');
    const kali = missing.find(m => m.topic === 'Kali Devi');
    expect(kali.hint).toMatch(/^[A-Z]-\d+\.\d+: .*[\u0C80-\u0CFF]/);
    expect(markdown).toMatch(/topics without a Kannada name/);
    expect(markdown).toContain('"Kali Devi": { "kn": "" },');          // a snippet to paste
});

test('a name that matches no topic is flagged as stale', () => {
    const { stale } = run({ ...bookConfig, topicNames: { ...bookConfig.topicNames, 'No Such Topic': { kn: '\u0C85' } }, aliases: { 'Nobody Yaksha': 'No Such Topic' } });
    expect(stale).toEqual(['No Such Topic', 'Nobody Yaksha']);
});

test('with every name present, says so', () => {
    const topicNames = Object.fromEntries(run({}).missing.map(m => [m.topic, { kn: '\u0C85' }]));
    const { missing, markdown } = run({ topicNames });
    expect(missing).toEqual([]);
    expect(markdown).toMatch(/Every topic in a comparison has a Kannada name/);
});

test('malformed config entries are listed as problems', () => {
    const { problems, markdown } = run({ aliases: { A: 5 } });
    expect(problems.length).toBeGreaterThan(0);
    expect(markdown).toMatch(/Problems in study-config.json/);
});

test('another language: the report asks for names in that language', () => {
    const { markdown } = run(bookConfig, 'en');
    expect(markdown).toMatch(/topics without a English name|without a English name/);
});
