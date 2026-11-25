const { createDrive, FILE_NAME, DriveError } = require('./drive');

const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('findFile asks the hidden app-data folder for the progress file, oldest first', async () => {
    const f = jest.fn().mockResolvedValue(res({ files: [{ id: 'one' }, { id: 'two' }] }));
    expect(await createDrive(f).findFile('tok')).toBe('one');
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('spaces=appDataFolder');
    expect(decodeURIComponent(url)).toContain(FILE_NAME);
    expect(url).toContain('orderBy=createdTime');
    expect(init.headers.Authorization).toBe('Bearer tok');
});
test('findFile gives null when there is none', async () => {
    expect(await createDrive(async () => res({ files: [] })).findFile('t')).toBeNull();
});
test('readFile: unreadable content is null; errors carry the HTTP status', async () => {
    const bad = { ok: true, status: 200, json: async () => { throw new Error('x'); } };
    expect(await createDrive(async () => bad).readFile('t', 'id')).toBeNull();
    await expect(createDrive(async () => res({}, 401)).readFile('t', 'id')).rejects.toMatchObject({ status: 401, name: 'DriveError' });
    expect(new DriveError(403).status).toBe(403);
});
test('writeFile creates inside appDataFolder, then updates in place', async () => {
    const f = jest.fn().mockResolvedValue(res({ id: 'new' }));
    const drive = createDrive(f);
    expect(await drive.writeFile('t', null, { v: 1 })).toBe('new');
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('uploadType=multipart');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('"parents":["appDataFolder"]');
    expect(init.body).toContain('{"v":1}');
    expect(await drive.writeFile('t', 'abc', { v: 1 })).toBe('abc');
    expect(f.mock.calls[1][1].method).toBe('PATCH');
    expect(f.mock.calls[1][0]).toContain('/files/abc?uploadType=media');
});
test('whoAmI never throws', async () => {
    expect(await createDrive(async () => res({ user: { displayName: 'A', emailAddress: 'a@x.com' } })).whoAmI('t')).toEqual({ name: 'A', email: 'a@x.com' });
    expect(await createDrive(async () => res({}, 500)).whoAmI('t')).toBeNull();
});
