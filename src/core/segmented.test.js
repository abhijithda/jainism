const { enhanceSegmented, initSegmented } = require('./segmented');

function makeSelect(id = 'engine', value = 'off') {
    document.body.innerHTML = `<label for="${id}">AI assistant<span>hint</span></label>
        <select id="${id}"><option value="off">Off</option><option value="cloud">Cloud</option><option value="local">Local</option></select>`;
    const select = document.getElementById(id);
    select.value = value;
    return select;
}
const buttons = () => [...document.querySelectorAll('.seg button')];
const checked = () => buttons().filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.value);

describe('enhanceSegmented', () => {
    test('adds one button per option next to the select and marks the current one', () => {
        const select = makeSelect('engine', 'cloud');
        enhanceSegmented(select);
        expect(buttons().map(b => b.textContent)).toEqual(['Off', 'Cloud', 'Local']);
        expect(checked()).toEqual(['cloud']);
        expect(select.classList.contains('seg-source')).toBe(true);
        expect(select.nextElementSibling.getAttribute('role')).toBe('radiogroup');
    });

    test('clicking a button sets the select and fires its change event', () => {
        const select = makeSelect();
        const onChange = jest.fn();
        select.addEventListener('change', onChange);
        enhanceSegmented(select);
        buttons()[2].click();
        expect(select.value).toBe('local');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(checked()).toEqual(['local']);
    });

    test('setting select.value from code (no event) updates the buttons', () => {
        const select = makeSelect();
        enhanceSegmented(select);
        select.value = 'cloud';
        expect(checked()).toEqual(['cloud']);
    });

    test('is safe to call twice, and with nothing', () => {
        const select = makeSelect();
        enhanceSegmented(select);
        enhanceSegmented(select);
        expect(document.querySelectorAll('.seg')).toHaveLength(1);
        expect(() => enhanceSegmented(null)).not.toThrow();
        expect(() => initSegmented(['engine', 'missing'])).not.toThrow();
    });

    test('arrow keys move the choice like a radio group', () => {
        const select = makeSelect();
        enhanceSegmented(select);
        document.querySelector('.seg').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(select.value).toBe('cloud');
        document.querySelector('.seg').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(select.value).toBe('off');
    });
});
