const { createAuth, DRIVE_SCOPE } = require('./auth');

function fakeWin(respond) {
    const win = { google: { accounts: { oauth2: {
        initTokenClient: cfg => ({ requestAccessToken: opts => { win.lastOpts = opts; respond(cfg, opts); } }),
        hasGrantedAllScopes: (resp) => resp.scope === DRIVE_SCOPE,
        revoke: jest.fn(),
    } } } };
    return win;
}

test('interactive sign-in resolves with the token and caches it until it nearly expires', async () => {
    let calls = 0, t = 0;
    const win = fakeWin(cfg => { calls++; cfg.callback({ access_token: 'T', expires_in: 3600, scope: DRIVE_SCOPE }); });
    const auth = createAuth({ clientId: 'id', win, now: () => t });
    expect(await auth.getToken({ interactive: true })).toBe('T');
    expect(win.lastOpts.prompt).toBe('');
    expect(await auth.getToken()).toBe('T');
    expect(calls).toBe(1);
    t = 3600 * 1000;                                  // expired: asks again, quietly
    await auth.getToken();
    expect(calls).toBe(2);
    expect(win.lastOpts.prompt).toBe('none');
});

test('declining the Drive scope is an error, not a silent partial sign-in', async () => {
    const win = fakeWin(cfg => cfg.callback({ access_token: 'T', expires_in: 3600, scope: 'openid' }));
    await expect(createAuth({ clientId: 'id', win }).getToken({ interactive: true })).rejects.toMatchObject({ code: 'scope_denied' });
});

test('Google errors and a blocked popup reject with a code', async () => {
    let win = fakeWin(cfg => cfg.callback({ error: 'interaction_required' }));
    await expect(createAuth({ clientId: 'id', win }).getToken()).rejects.toMatchObject({ code: 'interaction_required' });
    win = fakeWin(cfg => cfg.error_callback({ type: 'popup_failed_to_open' }));
    await expect(createAuth({ clientId: 'id', win }).getToken({ interactive: true })).rejects.toMatchObject({ code: 'popup_failed_to_open' });
});

test('revoke tells Google and forgets the token', async () => {
    const win = fakeWin(cfg => cfg.callback({ access_token: 'T', expires_in: 3600, scope: DRIVE_SCOPE }));
    const auth = createAuth({ clientId: 'id', win });
    await auth.getToken({ interactive: true });
    auth.revoke();
    expect(win.google.accounts.oauth2.revoke).toHaveBeenCalledWith('T', expect.any(Function));
    expect(auth.hasValidToken()).toBe(false);
});
