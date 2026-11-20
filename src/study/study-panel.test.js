// Drives the real panel in jsdom with the real data.json: tick -> nudge -> panel -> reveal -> record.
const fs = require('fs');
const path = require('path');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'data.json'), 'utf8'));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

let panel, mockEngine;
jest.mock('../ai/engines/index.js', () => ({ getEngine: () => mockEngine }));

// Questions only draw on what has been read: the note that names Loka Moodhata must be read too.
const lokaNote = data.flatMap(i => i.blocks || []).find(b => /Loka Moodhata/.test((b.content?.en || []).join(' ')));
const tickBlock = blockId => {
    const set = new Set(JSON.parse(localStorage.getItem('readBlocks') || '[]')).add(blockId).add(lokaNote.id);
    localStorage.setItem('readBlocks', JSON.stringify([...set]));
    document.dispatchEvent(new CustomEvent('pooja:block-read', { detail: { blockId, read: true } }));
};
const devaBlock = () => data.flatMap(i => i.blocks || []).find(b => (b.tags || []).includes('Deva Moodhata') && !(b.tags || []).includes('Shasana Devata'));
const $ = id => document.getElementById(id);

function boot({ study = true, onCite = jest.fn() } = {}) {
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
    localStorage.clear(); sessionStorage.clear();
    if (study) localStorage.setItem('settings', JSON.stringify({ studyCompanion: true }));
    mockEngine = null;
    jest.isolateModules(() => { panel = require('./study-panel.js'); });
    panel.initStudy({ data, onCite });
    return onCite;
}

afterEach(() => jest.useRealTimers());

test('off by default: the Study button stays hidden and ticks produce nothing', () => {
    boot({ study: false });
    expect($('study-btn').hidden).toBe(true);
    tickBlock(devaBlock().id);
    expect($('study-nudge').hidden).toBe(true);
    expect($('study-badge').textContent).toBe('');
});

test('marking a block read shows a nudge (not the panel); opening it lists the question', () => {
    boot();
    expect($('study-btn').hidden).toBe(false);
    tickBlock(devaBlock().id);
    expect($('study-nudge').hidden).toBe(false);
    expect($('study-nudge').textContent).toMatch(/Deva Moodhata vs Loka Moodhata/);
    expect($('study-drawer').hidden).toBe(true);                       // never opens by itself
    expect($('study-badge').textContent).not.toBe('');

    $('study-nudge').querySelector('.study-nudge-open').click();
    expect($('study-drawer').hidden).toBe(false);
    expect($('study-nudge').hidden).toBe(true);
    expect($('study-body').textContent).toContain('You just read about Deva Moodhata. Can you explain how it differs from Loka Moodhata?');
    // the book's words stay hidden until asked for
    expect($('study-body').querySelector('.ai-passage')).toBeNull();
});

test('un-ticking does nothing, and the nudge goes away by itself', () => {
    jest.useFakeTimers();
    boot();
    document.dispatchEvent(new CustomEvent('pooja:block-read', { detail: { blockId: devaBlock().id, read: false } }));
    expect($('study-nudge').hidden).toBe(true);
    tickBlock(devaBlock().id);
    expect($('study-nudge').hidden).toBe(false);
    jest.advanceTimersByTime(16000);
    expect($('study-nudge').hidden).toBe(true);
});

test('reveal shows the book\u2019s words with chips that open the passage; "I got it" records it and it is not asked again', () => {
    const onCite = boot();
    const b = devaBlock();
    tickBlock(b.id);
    $('study-btn').click();
    [...$('study-body').querySelectorAll('button')].find(x => /Show what the book says/.test(x.textContent)).click();
    const chips = $('study-body').querySelectorAll('.ai-passage .ai-cite');
    expect(chips.length).toBeGreaterThan(1);
    expect($('study-body').textContent).toMatch(/What the book says about Loka Moodhata/);
    chips[0].click();
    expect(onCite).toHaveBeenCalledWith(expect.any(String));

    const cardsBefore = $('study-body').querySelectorAll('.study-card').length;
    [...$('study-body').querySelectorAll('button')].find(x => /I got it/.test(x.textContent)).click();
    expect($('study-body').querySelectorAll('.study-card').length).toBe(cardsBefore - 1);
    expect(JSON.parse(localStorage.getItem('studyLog'))['compare:deva moodhata|loka moodhata'].status).toBe('got');

    tickBlock(b.id);                                                    // same topic again
    expect($('study-body').textContent).not.toContain('differs from Loka Moodhata');
});

test('"Review later" keeps it in a review list that can be practised again', () => {
    boot();
    tickBlock(devaBlock().id);
    $('study-btn').click();
    [...$('study-body').querySelectorAll('button')].find(x => /Show what the book says/.test(x.textContent)).click();
    [...$('study-body').querySelectorAll('button')].find(x => /Review later/.test(x.textContent)).click();
    expect($('study-body').textContent).toMatch(/To review \(1\)/);
    [...$('study-body').querySelectorAll('button')].find(x => /Practise again/.test(x.textContent)).click();
    expect($('study-body').textContent).toContain('differs from Loka Moodhata');
});

test('pending questions and the open panel survive a reload of the page', () => {
    boot();
    tickBlock(devaBlock().id);
    $('study-btn').click();
    const saved = sessionStorage.getItem('studySession');
    document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
    sessionStorage.setItem('studySession', saved);
    jest.isolateModules(() => { panel = require('./study-panel.js'); });
    panel.initStudy({ data, onCite() {} });
    expect($('study-drawer').hidden).toBe(false);
    expect($('study-body').textContent).toContain('differs from Loka Moodhata');
});

test('turning the switch on also turns read tracking on, and off hides the button', () => {
    boot({ study: false });
    $('toggle-read-tracking').checked = false;
    $('toggle-study').checked = true;
    $('toggle-study').dispatchEvent(new Event('change', { bubbles: true }));
    expect($('toggle-read-tracking').checked).toBe(true);
    expect($('study-btn').hidden).toBe(false);
    expect(JSON.parse(localStorage.getItem('settings')).studyCompanion).toBe(true);
    $('toggle-study').checked = false;
    $('toggle-study').dispatchEvent(new Event('change', { bubbles: true }));
    expect($('study-btn').hidden).toBe(true);
});

describe('Study needs Read tracking', () => {
    test('a saved "Study on, Read tracking off" is repaired at load: ticks on, switches locked', () => {
        document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '');
        localStorage.clear(); sessionStorage.clear();
        localStorage.setItem('settings', JSON.stringify({ studyCompanion: true, readTracking: false }));
        jest.isolateModules(() => { panel = require('./study-panel.js'); });
        // what header.js does at load for its own switch
        $('toggle-read-tracking').addEventListener('change', () => {
            document.body.classList.toggle('show-read-tracking', $('toggle-read-tracking').checked);
            const s = JSON.parse(localStorage.getItem('settings')); s.readTracking = $('toggle-read-tracking').checked; localStorage.setItem('settings', JSON.stringify(s));
        });
        panel.initStudy({ data, onCite() {} });
        expect($('toggle-read-tracking').checked).toBe(true);
        expect(document.body.classList.contains('show-read-tracking')).toBe(true);
        expect(JSON.parse(localStorage.getItem('settings')).readTracking).toBe(true);
        expect($('toggle-read-tracking').dataset.locked).toBe('1');
        expect($('home-toggle-read-tracking').checked).toBe(true);
        expect($('home-toggle-read-tracking').dataset.locked).toBe('1');
        expect($('rt-lock-note').hidden).toBe(false);
        expect($('rt-lock-note').textContent).toMatch(/Read tracking stays on while the study companion is on/);
        expect($('home-rt-lock-note').hidden).toBe(false);
    });

    test('switching Study off unlocks Read tracking (it stays on) in both places', () => {
        boot();
        expect($('toggle-read-tracking').dataset.locked).toBe('1');
        $('toggle-study').checked = false;
        $('toggle-study').dispatchEvent(new Event('change', { bubbles: true }));
        expect($('toggle-read-tracking').dataset.locked).toBe('');
        expect($('home-toggle-read-tracking').dataset.locked).toBe('');
        expect($('toggle-read-tracking').checked).toBe(true);
        expect($('rt-lock-note').hidden).toBe(true);
        expect($('home-rt-lock-note').hidden).toBe(true);
    });

    test('trying to switch Read tracking off while Study is on is refused, and the note lights up to say why', () => {
        boot();
        const rt = $('toggle-read-tracking');
        rt.click();                                              // what a tap does
        expect(rt.checked).toBe(true);                           // refused
        expect($('rt-lock-note').classList.contains('rt-lock-flash')).toBe(true);
        $('home-toggle-read-tracking').click();
        expect($('home-toggle-read-tracking').checked).toBe(true);
        expect($('home-rt-lock-note').classList.contains('rt-lock-flash')).toBe(true);
    });

    test('with Study off, Read tracking switches normally', () => {
        boot({ study: false });
        const rt = $('toggle-read-tracking');
        rt.click();
        expect(rt.checked).toBe(true);
        rt.click();
        expect(rt.checked).toBe(false);
    });
});

describe('settings lists', () => {
    const order = (root, prefix) => [...root.querySelectorAll('input[type="checkbox"]')].map(i => i.id.replace(prefix, '')).filter(id => /^(videos|qrs|read-tracking|study|offline)$/.test(id));
    test('the header menu and the Home page list their switches in the same order', () => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const header = order(doc.querySelector('.menu-dropdown, #settings-menu, #settings-dropdown') || doc.body, 'toggle-');
        const home = order(doc.querySelector('.home-settings'), 'home-toggle-');
        expect(header.length).toBe(5);
        expect(header).toEqual(['videos', 'qrs', 'read-tracking', 'study', 'offline']);
        expect(home).toEqual(header);
    });
});

describe('with a hosted AI engine', () => {
    const hosted = reply => ({ id: 'cloud', available: () => ({ ok: true }), generate: jest.fn(async () => reply) });
    const flush = () => new Promise(r => setTimeout(r, 0));
    const open = () => { tickBlock(devaBlock().id); $('study-btn').click(); };
    const btn = re => [...$('study-body').querySelectorAll('button')].find(x => re.test(x.textContent));

    test('no AI buttons without an engine, or with an on-device one', () => {
        boot(); open();
        expect(btn(/AI/)).toBeUndefined();
        mockEngine = { id: 'local', available: () => ({ ok: true }), generate: jest.fn() };
        $('study-btn').click(); $('study-btn').click();
        expect(btn(/AI/)).toBeUndefined();
    });

    test('"Another question from the AI" adds a validated question; nothing is sent until clicked', async () => {
        boot(); open();
        const sent = jest.fn();
        mockEngine = hosted('');
        mockEngine.generate = jest.fn(async (messages) => {
            sent(messages);
            const label = /\[([A-Z]-\d+\.\d+)\]/.exec(messages[1].content)[1];
            return JSON.stringify({ question: 'What is Deva Moodhata?', answer: `Delusion about Bhagawan [${label}].` });
        });
        $('study-btn').click(); $('study-btn').click();                 // re-render with the engine present
        expect(sent).not.toHaveBeenCalled();
        btn(/Another question from the AI/).click();
        await flush(); await flush();
        expect(sent).toHaveBeenCalledTimes(1);
        expect($('study-body').textContent).toContain('What is Deva Moodhata?');
        expect($('study-body').textContent).toContain('Question from the AI');
    });

    const labelsIn = messages => [...messages[1].content.matchAll(/\[([A-Z]-\d+\.\d+)\]/g)].map(m => m[1]);

    test('each click uses a different part of what was read, so the questions differ', async () => {
        boot(); open();
        const firstLabels = [];
        mockEngine = hosted('');
        mockEngine.generate = jest.fn(async (messages) => {
            const labels = labelsIn(messages);
            firstLabels.push(labels[0]);
            return JSON.stringify({ question: `Question about ${labels[0]}?`, answer: `See [${labels[0]}].` });
        });
        $('study-btn').click(); $('study-btn').click();
        btn(/Another question from the AI/).click(); await flush(); await flush();
        btn(/Another question from the AI/).click(); await flush(); await flush();
        expect(firstLabels).toHaveLength(2);
        expect(firstLabels[0]).not.toBe(firstLabels[1]);
        expect($('study-body').textContent).toContain(`Question about ${firstLabels[0]}?`);
        expect($('study-body').textContent).toContain(`Question about ${firstLabels[1]}?`);
        expect($('study-body').textContent).toMatch(/Question from the AI \u00B7 about /);
    });

    test('the same question coming back is not added twice; earlier questions are sent to avoid', async () => {
        boot(); open();
        mockEngine = hosted('');
        mockEngine.generate = jest.fn(async (messages) => JSON.stringify({ question: 'What is Deva Moodhata?', answer: `Delusion [${labelsIn(messages)[0]}].` }));
        $('study-btn').click(); $('study-btn').click();
        btn(/Another question from the AI/).click(); await flush(); await flush();
        const before = mockEngine.generate.mock.calls.length;
        btn(/Another question from the AI/).click(); await flush(); await flush(); await flush(); await flush();
        const cards = [...$('study-body').querySelectorAll('.study-prompt')].filter(p => p.textContent === 'What is Deva Moodhata?');
        expect(cards).toHaveLength(1);                                           // not piled up
        expect(mockEngine.generate.mock.calls.length - before).toBeLessThanOrEqual(3);   // gave up after a few tries
        expect(mockEngine.generate.mock.calls[before][0][1].content).toContain('What is Deva Moodhata?');   // and was told not to repeat it
        expect($('study-body').textContent).toMatch(/already had/);
    });

    test('an AI question that cites nothing real is dropped with a message', async () => {
        boot(); open();
        mockEngine = hosted('{"question":"Q?","answer":"No citation."}');
        $('study-btn').click(); $('study-btn').click();
        btn(/Another question from the AI/).click();
        await flush(); await flush();
        expect($('study-body').textContent).not.toContain('Q?');
        expect($('study-body').textContent).toMatch(/didn.t produce a question it could back up/);
    });

    test('"Check my answer" shows cited feedback; uncited feedback is replaced by the passages', async () => {
        boot(); open();
        mockEngine = hosted('placeholder');
        $('study-btn').click(); $('study-btn').click();
        const box = $('study-body').querySelector('.study-answer');
        box.value = 'my answer'; box.dispatchEvent(new Event('input'));
        mockEngine.generate = jest.fn(async (messages) => {
            const label = /\[([A-Z]-\d+\.\d+)\]/.exec(messages[1].content)[1];
            return `Good start [${label}].`;
        });
        btn(/Check my answer/).click();
        await flush(); await flush();
        expect($('study-body').querySelector('.study-feedback .ai-cite')).not.toBeNull();

        mockEngine.generate = jest.fn(async () => 'You are right.');
        btn(/Check my answer/).click();
        await flush(); await flush();
        expect($('study-body').textContent).toMatch(/couldn.t give feedback it could back up/);
        expect($('study-body').querySelector('.ai-passage')).not.toBeNull();   // the book's words are shown instead
    });
});
