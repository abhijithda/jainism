const { createSyncConfig, loadSyncConfig } = require('./sync-config');

const ID = '1234567890-abc123def.apps.googleusercontent.com';

test('a valid client ID turns sync on', () => {
    expect(createSyncConfig({ googleClientId: ` ${ID} ` })).toEqual({ clientId: ID, enabled: true, problems: [] });
});
test('empty, missing or malformed means off, quietly or with a note', () => {
    expect(createSyncConfig({ googleClientId: '' }).enabled).toBe(false);
    expect(createSyncConfig({ googleClientId: '' }).problems).toEqual([]);
    expect(createSyncConfig(null).enabled).toBe(false);
    expect(createSyncConfig({ googleClientId: 'nope' }).problems).toHaveLength(1);
    expect(createSyncConfig({ googleClientId: 5 }).problems).toHaveLength(1);
    expect(createSyncConfig({ other: 1 }).problems).toHaveLength(1);
});
test('loadSyncConfig never fails', async () => {
    expect((await loadSyncConfig({ fetchFn: async () => ({ ok: false }) })).enabled).toBe(false);
    expect((await loadSyncConfig({ fetchFn: async () => { throw new Error('offline'); } })).enabled).toBe(false);
    expect((await loadSyncConfig({ fetchFn: async () => ({ ok: true, json: async () => ({ googleClientId: ID }) }) })).enabled).toBe(true);
});
test('the shipped config file is valid and ships empty', () => {
    const raw = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../assets/sync-config.json'), 'utf8'));
    expect(createSyncConfig(raw).problems).toEqual([]);
});
