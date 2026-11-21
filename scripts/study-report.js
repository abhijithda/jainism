#!/usr/bin/env node
// study-report.js — What the study companion will do with the book as it is now. Run it after adding content:
//
//   npm run study:report            (or: node scripts/study-report.js [--data path/to/data.json])
//
// It needs no AI and no network. It prints:
//   1. the comparisons the study companion can ask ("Deva Moodhata <-> Loka Moodhata", ...), so a new
//      tag that creates a strange pair is seen before readers see it;
//   2. the topics in those comparisons that have no Kannada name yet (src/study/topic-names.js), each with
//      the book's own Kannada line to copy the spelling from. Until a name is added the question shows
//      the English tag, so nothing breaks;
//   3. entries in topic-names.js that no longer match a topic of the book.
//
// The logic is a pure function (buildReport) that takes the modules as arguments, so the unit test can call it
// directly (the src modules are ES modules for the browser; the CLI loads them with import(), Node 22).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const lower = s => String(s).toLowerCase();

/**
 * @param {{data: Array, retrieval: Object, study: Object, names: Object}} deps
 *   names: the TOPIC_NAMES object ({'Kali Devi': {kn: '...'}, ...})
 * @returns {{pairs: {a:string,b:string,together:boolean}[], missing: {topic:string, hint:string}[], stale: string[], markdown: string}}
 */
function buildReport({ data, retrieval, study, names }) {
    const index = retrieval.createIndex(data);
    const model = study.buildStudyModel(index);

    const allTopics = new Map();   // lower -> name, tags and phrases only the text names
    model.topics.forEach(t => allTopics.set(lower(t.name), t.name));
    model.phrases.forEach(p => { if (!allTopics.has(lower(p))) allTopics.set(lower(p), p); });

    const pairs = [];
    const seen = new Set();
    allTopics.forEach(name => study.comparisonsFor(model, name).forEach(c => {
        const key = [lower(name), lower(c.name)].sort().join('|');
        if (seen.has(key)) return;
        seen.add(key);
        pairs.push({ a: name, b: c.name, together: c.together });
    }));
    pairs.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

    const have = new Set(Object.keys(names).map(lower));
    const used = new Map();
    pairs.forEach(p => [p.a, p.b].forEach(n => used.set(lower(n), n)));
    const missing = [...used.entries()].filter(([k]) => !have.has(k)).map(([, topic]) => {
        const chunk = index.chunks.find(c => c.tags.some(t => lower(t) === lower(topic)) || lower(c.text.en || '').includes(lower(topic)));
        const kn = chunk?.text.kn ? chunk.text.kn.replace(/\s+/g, ' ').slice(0, 110) : '';
        return { topic, hint: chunk ? `${chunk.label}${kn ? `: ${kn}` : ''}` : '' };
    });
    const stale = Object.keys(names).filter(n => !allTopics.has(lower(n)));

    const out = [];
    out.push(`# Study companion report`, '', `${pairs.length} comparison${pairs.length === 1 ? '' : 's'} can be asked:`, '');
    pairs.forEach(p => out.push(`- ${p.a} <-> ${p.b}${p.together ? '  (named together in the book)' : ''}`));
    out.push('', missing.length ? `## ${missing.length} topic${missing.length === 1 ? '' : 's'} without a Kannada name (shown with the English tag until added to src/study/topic-names.js)` : '## Every topic in a comparison has a Kannada name', '');
    missing.forEach(m => out.push(`- ${m.topic}${m.hint ? `  <- ${m.hint}` : ''}`));
    if (stale.length) { out.push('', '## Names in topic-names.js that match no topic of the book (remove or fix)', ''); stale.forEach(n => out.push(`- ${n}`)); }
    return { pairs, missing, stale, markdown: out.join('\n') + '\n' };
}

async function main() {
    const argv = process.argv.slice(2);
    const dataPath = argv.includes('--data') ? argv[argv.indexOf('--data') + 1] : path.join(ROOT, 'assets', 'data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
    const [retrieval, study, topicNames] = await Promise.all([load('src/ai/retrieval.js'), load('src/study/study-questions.js'), load('src/study/topic-names.js')]);
    process.stdout.write(buildReport({ data, retrieval, study, names: topicNames.TOPIC_NAMES }).markdown);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { buildReport };
