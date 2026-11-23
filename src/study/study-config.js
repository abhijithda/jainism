// study/study-config.js — Everything the study companion knows about THE BOOK rather than how to ask questions,
// read from assets/study-config.json (next to data.json). A different book brings its own file; the code stays.
//
//   topicNames  Kannada (or other) names for topics, so a question in Kannada says the topic in Kannada:
//               { "Kali Devi": { "kn": "ಕಾಳಿ ದೇವಿ" } }
//   aliases     one topic under two names:  { "Govadana Yaksha": "Gomukha Yaksha" }  (second name -> main name)
//   titleWords  words that start a person's name (queen, shri...), so "Queen X" and "Rani X" are not compared
//
// Every part is optional. With no file, or an empty one, the study companion still works: topics are shown as
// their tags, nothing is merged, and no title words are skipped. A malformed entry is ignored (listed in
// `problems`, which the tests and `npm run study:report` show) rather than breaking the page.

const lower = s => String(s).trim().toLowerCase();
const isText = v => typeof v === 'string' && v.trim() !== '';
const isPlainObject = v => v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {Object} [raw]  the parsed study-config.json (anything else is treated as empty)
 */
export function createStudyConfig(raw) {
    const problems = [];
    const src = isPlainObject(raw) ? raw : {};
    ['topicNames', 'aliases', 'titleWords'].forEach(key => {
        if (src[key] !== undefined && !(key === 'titleWords' ? Array.isArray(src[key]) : isPlainObject(src[key]))) problems.push(`"${key}" has the wrong type`);
    });
    Object.keys(src).forEach(key => { if (!['topicNames', 'aliases', 'titleWords'].includes(key)) problems.push(`unknown key "${key}"`); });

    const topicNames = {};
    Object.entries(isPlainObject(src.topicNames) ? src.topicNames : {}).forEach(([topic, byLang]) => {
        if (!isPlainObject(byLang)) { problems.push(`topicNames "${topic}" should be an object like { "kn": "..." }`); return; }
        const langs = {};
        Object.entries(byLang).forEach(([lang, name]) => {
            if (isText(name)) langs[lang] = name.trim();
            else if (name !== '') problems.push(`topicNames "${topic}" "${lang}" should be text`);   // "" = not filled in yet: fine
        });
        if (Object.keys(langs).length) topicNames[topic] = langs;
    });

    const aliases = {};
    Object.entries(isPlainObject(src.aliases) ? src.aliases : {}).forEach(([alias, main]) => {
        if (!isText(main)) problems.push(`alias "${alias}" should point at a topic name`);
        else if (lower(alias) === lower(main)) problems.push(`alias "${alias}" points at itself`);
        else aliases[alias] = main.trim();
    });
    Object.entries(aliases).forEach(([alias, main]) => {
        if (aliases[main] !== undefined) problems.push(`alias "${alias}" points at "${main}", which is itself an alias (no chains)`);
    });

    const titleWords = (Array.isArray(src.titleWords) ? src.titleWords : []).filter(w => {
        if (isText(w)) return true;
        problems.push('titleWords should be a list of words');
        return false;
    }).map(lower);

    const namesByLower = new Map(Object.entries(topicNames).map(([k, v]) => [lower(k), v]));
    const mainByAlias = new Map(Object.entries(aliases).map(([alias, main]) => [lower(alias), main]));
    const titles = new Set(titleWords);

    return {
        raw: { topicNames, aliases, titleWords },
        problems,
        /** The topic's name in `lang`, or the topic as the tags write it when there is none. */
        topicName: (name, lang) => namesByLower.get(lower(name))?.[lang] || name,
        /** The name the study companion uses for `name` (itself unless the book has a second name for it). */
        canonicalTopic: name => mainByAlias.get(lower(name)) || name,
        /** The other names the book uses for `name`. */
        aliasesOf: name => Object.entries(aliases).filter(([, main]) => lower(main) === lower(name)).map(([alias]) => alias),
        /** [alias, main name] pairs. */
        aliasEntries: () => Object.entries(aliases),
        isTitleWord: word => titles.has(lower(word)),
        /** Topics that have a name in `lang`. */
        namedTopics: lang => Object.entries(topicNames).filter(([, v]) => v[lang]).map(([k]) => k),
    };
}

/**
 * Fetches the book's study config. Never fails: no file, a network error or bad JSON give the empty config, so the
 * study companion still works (the offline copy saves this file when it is there).
 */
export async function loadStudyConfig({ url = 'assets/study-config.json', fetchFn } = {}) {
    try {
        const res = await (fetchFn || fetch)(url);
        if (!res.ok) return createStudyConfig({});
        return createStudyConfig(await res.json());
    } catch (_) {
        return createStudyConfig({});
    }
}

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { createStudyConfig, loadStudyConfig });
