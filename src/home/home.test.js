// The AI-assistant picker exists twice: in the header's Settings menu and in
// the Home page's settings mirror. They must always agree, whichever is used.

const { initHomeControls, refreshHomeView } = require('./home');
const { initAi } = require('../ai/ai-panel');
const { saveSettings } = require('../core/settings');

const fire = (el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
const stored = () => JSON.parse(localStorage.getItem('settings')).aiEngine;

function setup(saved) {
    localStorage.clear();
    if (saved) saveSettings({ aiEngine: saved });
    document.body.innerHTML = `
        <button id="ai-btn" hidden></button>
        <div id="header-menu">
            <select id="ai-engine-select"><option value="off"></option><option value="cloud"></option><option value="local"></option></select>
            <span id="ai-engine-note"></span>
            <button id="font-scale-increase"></button>
        </div>
        <div class="home-settings">
            <select id="home-ai-engine-select"><option value="off"></option><option value="cloud"></option><option value="local"></option></select>
            <p id="home-ai-engine-note"></p>
            <span id="home-font-scale-display"></span>
        </div>`;
    initHomeControls([]);
    initAi({ data: [], onCite: () => {} });
}

const header = () => document.getElementById('ai-engine-select');
const home = () => document.getElementById('home-ai-engine-select');

test('on load, both pickers show the saved engine', () => {
    setup('local');
    expect(header().value).toBe('local');
    expect(home().value).toBe('local');
});

test('changing it in the header updates the Home page at once', () => {
    setup();
    fire(header(), 'cloud');
    expect(stored()).toBe('cloud');
    expect(home().value).toBe('cloud');
});

test('changing it on Home saves it and updates the header', () => {
    setup();
    fire(home(), 'local');
    expect(stored()).toBe('local');
    expect(header().value).toBe('local');
    expect(home().value).toBe('local');
});

test('both notes always say the same thing', () => {
    setup();
    fire(header(), 'local');
    const a = document.getElementById('ai-engine-note').textContent;
    const b = document.getElementById('home-ai-engine-note').textContent;
    expect(a).not.toBe('');
    expect(b).toBe(a);
    fire(header(), 'off');
    expect(document.getElementById('home-ai-engine-note').textContent).toBe('');
});

test('a font-size change in the header refreshes the Home page display too', () => {
    jest.useFakeTimers();
    setup();
    saveSettings({ fontScale: 1.2 });
    document.getElementById('font-scale-increase').click();
    jest.runAllTimers();
    expect(document.getElementById('home-font-scale-display').textContent).toBe('120%');
    jest.useRealTimers();
});

test('the Home cover shows each language\'s title, then its subtitle styled as a subtitle', () => {
    localStorage.clear();
    saveSettings({ langs: ['kn', 'en'] });
    document.body.innerHTML = '<img id="home-cover-image"><div id="home-cover-title"></div>';
    initHomeControls([{ id: 'c', type: 'insert', blocks: [{ id: 'b', content: {
        kn: ['ಶೀರ್ಷಿಕೆ', 'ಉಪಶೀರ್ಷಿಕೆ'], en: ['Title', 'Subtitle'] } }] }]);
    refreshHomeView();
    const lines = [...document.querySelectorAll('#home-cover-title .home-cover-title-line')];
    expect(lines.map(l => l.textContent)).toEqual(['ಶೀರ್ಷಿಕೆ', 'ಉಪಶೀರ್ಷಿಕೆ', 'Title', 'Subtitle']);
    expect(lines.map(l => l.classList.contains('is-subtitle'))).toEqual([false, true, false, true]);
});

describe('Home progress card and main button', () => {
    const book = [{ id: 'q1', type: 'qa', blocks: [
        { id: 'q1_b_1', type: 'question', content: { en: ['One?'] } },
        { id: 'q1_b_2', type: 'answer', content: { en: ['Two.'] } },
    ] }];

    function page() {
        localStorage.clear();
        document.body.innerHTML = '<div id="home-progress"></div><span id="home-continue-label"></span>';
        initHomeControls(book);
    }

    test('before reading: 0 read, and the button says Start reading', () => {
        page();
        refreshHomeView();
        expect(document.querySelector('#home-progress .home-progress-top').textContent).toMatch(/^0 of \d+ read0%$/);
        expect(document.getElementById('home-continue-label').textContent).toBe('Start reading');
    });

    test('after reading something: the count and bar move and the button says Continue reading', () => {
        page();
        const { saveReadBlocks } = require('../core/read-tracking');
        saveReadBlocks(new Set(['q1_b_1']), localStorage);
        refreshHomeView();
        expect(document.querySelector('#home-progress .home-progress-top').textContent).toMatch(/^1 of \d+ read\d+%$/);
        expect(parseInt(document.querySelector('#home-progress .bar i').style.width, 10)).toBeGreaterThan(0);
        expect(document.getElementById('home-continue-label').textContent).toBe('Continue reading');
    });
});
