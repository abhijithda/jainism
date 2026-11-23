#!/usr/bin/env node
// study-report.js — What the study companion will do with the book as it is now. Run it after adding content:
//
//   npm run study:report            (or: node scripts/study-report.js [--data path] [--config path] [--lang kn])
//
// It needs no AI and no network. It prints:
//   1. the comparisons the study companion can ask ("Deva Moodhata <-> Loka Moodhata", ...), so a new
//      tag that creates a strange pair is seen before readers see it;
//   2. the topics in those comparisons that have no name in the language yet (assets/study-config.json,
//      "topicNames"), each with the book's own line in that language to copy the spelling from, and a snippet to
//      paste. Until a name is added the question shows the tag, so nothing breaks;
//   3. entries in the config that no longer match a topic of the book, and anything in it that is malformed.
//
// The logic is a pure function (buildReport) that takes the modules as arguments, so the unit test can call it
// directly (the src modules are ES modules for the browser; the CLI loads them with import(), Node 22).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const lower = s => String(s).toLowerCase();
const LANGUAGE_NAMES = { kn: 'Kannada', en: 'English' };

/**
 * @param {{data: Array, retrieval: Object, study: Object, config: Object, lang?: string}} deps
 *   config: the object createStudyConfig() returns (study/study-config.js)
 * @returns {{pairs: {a:string,b:string,together:boolean}[], missing: {topic:string, hint:string}[], stale: string[], problems: string[], markdown: string}}
 */
function buildReport({ data, retrieval, study, config, lang = 'kn' }) {
    const index = retrieval.createIndex(data);
    const model = study.buildStudyModel(index, config);
    const langName = LANGUAGE_NAMES[lang] || lang;

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

    const used = new Map();
    pairs.forEach(p => [p.a, p.b].forEach(n => used.set(lower(n), n)));
    const missing = [...used.values()].filter(topic => config.topicName(topic, lang) === topic).map(topic => {
        const chunk = index.chunks.find(c => c.tags.some(t => lower(t) === lower(topic)) || lower(c.text.en || '').includes(lower(topic)));
        const line = chunk?.text[lang] ? chunk.text[lang].replace(/\s+/g, ' ').slice(0, 110) : '';
        return { topic, hint: chunk ? `${chunk.label}${line ? `: ${line}` : ''}` : '' };
    });

    const { topicNames, aliases } = config.raw;
    const stale = [
        ...Object.keys(topicNames).filter(n => !allTopics.has(lower(n))),
        ...Object.entries(aliases).filter(([alias, main]) => !allTopics.has(lower(main)) || allTopics.has(lower(alias))).map(([alias]) => alias),
    ];

    const out = [];
    out.push(`# Study companion report`, '', `${pairs.length} comparison${pairs.length === 1 ? '' : 's'} can be asked:`, '');
    pairs.forEach(p => out.push(`- ${p.a} <-> ${p.b}${p.together ? '  (named together in the book)' : ''}`));
    out.push('', missing.length
        ? `## ${missing.length} topic${missing.length === 1 ? '' : 's'} without a ${langName} name (shown with the English tag until added to assets/study-config.json)`
        : `## Every topic in a comparison has a ${langName} name`, '');
    missing.forEach(m => out.push(`- ${m.topic}${m.hint ? `  <- ${m.hint}` : ''}`));
    if (missing.length) {
        out.push('', `Paste into "topicNames" in assets/study-config.json and fill in each ${langName} name, spelled as the book spells it:`, '');
        missing.forEach(m => out.push(`    ${JSON.stringify(m.topic)}: { ${JSON.stringify(lang)}: "" },`));
    }
    if (stale.length) { out.push('', '## Entries in study-config.json that match no topic of the book (remove or fix)', ''); stale.forEach(n => out.push(`- ${n}`)); }
    if (config.problems.length) { out.push('', '## Problems in study-config.json (these entries are ignored)', ''); config.problems.forEach(p => out.push(`- ${p}`)); }
    return { pairs, missing, stale, problems: config.problems, markdown: out.join('\n') + '\n' };
}

async function main() {
    const argv = process.argv.slice(2);
    const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
    const data = JSON.parse(fs.readFileSync(arg('--data', path.join(ROOT, 'assets', 'data.json')), 'utf8'));
    const configPath = arg('--config', path.join(ROOT, 'assets', 'study-config.json'));
    const load = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
    const [retrieval, study, studyConfig] = await Promise.all([load('src/ai/retrieval.js'), load('src/study/study-questions.js'), load('src/study/study-config.js')]);
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    if (!fs.existsSync(configPath)) console.error(`(no ${path.relative(ROOT, configPath)}: reporting with an empty config)`);
    process.stdout.write(buildReport({ data, retrieval, study, config: studyConfig.createStudyConfig(raw), lang: arg('--lang', 'kn') }).markdown);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { buildReport };
