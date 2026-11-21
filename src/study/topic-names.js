// study/topic-names.js — Kannada names for topics, so a question in Kannada says "ಕಾಳಿ ದೇವಿ", not "Kali Devi".
//
// Topics come from the tags in data.json, which are written in Latin letters only. Each name below is the
// book's own spelling, taken from its Kannada text (study-names.test.js checks that every word of every name
// really occurs in the book's Kannada, so a typo cannot slip in). A topic with no entry here is shown as its
// tag, so a new tag still works; add it here to get a Kannada name.
//
// Keys are the tag / phrase exactly as the English text and tags write it (matched case-insensitively).

export const TOPIC_NAMES = {
    'Chakreshwari Devi':   { kn: 'ಚಕ್ರೇಶ್ವರಿ ದೇವಿ' },
    'Chakreshwari Yakshi': { kn: 'ಚಕ್ರೇಶ್ವರಿ ಯಕ್ಷಿ' },
    'Deva Moodhata':       { kn: 'ದೇವ ಮೂಢತೆ' },
    'Guru Moodhata':       { kn: 'ಗುರು ಮೂಢತೆ' },
    'Harivamsha Purana':   { kn: 'ಹರಿವಂಶ ಪುರಾಣ' },
    'Kali Devi':           { kn: 'ಕಾಳಿ ದೇವಿ' },
    'Loka Moodhata':       { kn: 'ಲೋಕ ಮೂಢತೆ' },
    'Madana Sundari':      { kn: 'ಮದನಸುಂದರಿ' },
    'Maha Purana':         { kn: 'ಮಹಾ ಪುರಾಣ' },
    'Maina Sundari':       { kn: 'ಮೈನಾ ಸುಂದರಿ' },
    'Mithya Drishti':      { kn: 'ಮಿತ್ಯಾದೃಷ್ಟಿ' },
    'Nava Devata':         { kn: 'ನವ ದೇವತೆ' },
    'Nishchaya Naya':      { kn: 'ನಿಶ್ಚಯ ನಯ' },
    'Padma Purana':        { kn: 'ಪದ್ಮ ಪುರಾಣ' },
    'Samyag Drishti':      { kn: 'ಸಮ್ಯಗ್ದೃಷ್ಟಿ' },
    'Shasana Devata':      { kn: 'ಶಾಸನ ದೇವತೆ' },
    'Uttara Purana':       { kn: 'ಉತ್ತರ ಪುರಾಣ' },
    'Vidya Devata':        { kn: 'ವಿದ್ಯಾ ದೇವತೆ' },
    'Vyavahara Naya':      { kn: 'ವ್ಯವಹಾರ ನಯ' },
    'Yaksha Yakshi':       { kn: 'ಯಕ್ಷ ಯಕ್ಷಿ' },
};

const byLower = new Map(Object.entries(TOPIC_NAMES).map(([k, v]) => [k.toLowerCase(), v]));

/** The topic's name in `lang`, or the topic as written in the tags when there is no name in that language. */
export const topicName = (name, lang) => byLower.get(String(name).toLowerCase())?.[lang] || name;

// CommonJS shim for Jest
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { TOPIC_NAMES, topicName });
