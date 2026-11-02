const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

/* ---------- address normalization ---------- */
test('normalize: bare domain defaults to https', () => {
  const r = C.normalizeServerUrl('hs.example.com');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://hs.example.com');
});
test('normalize: private/LAN hosts default to http', () => {
  assert.equal(C.normalizeServerUrl('192.168.1.5:8080').url, 'http://192.168.1.5:8080');
  assert.equal(C.normalizeServerUrl('localhost:8080').url, 'http://localhost:8080');
  assert.equal(C.normalizeServerUrl('10.0.0.2').url, 'http://10.0.0.2');
  assert.equal(C.normalizeServerUrl('nas.local').url, 'http://nas.local');
});
test('normalize: explicit scheme is respected, trailing slash removed', () => {
  assert.equal(C.normalizeServerUrl('http://hs.example.com:8080/').url, 'http://hs.example.com:8080');
  assert.equal(C.normalizeServerUrl('HTTPS://HS.Example.com//').url, 'https://hs.example.com');
});
test('normalize: strips pasted API suffixes but keeps sub-path prefixes', () => {
  assert.equal(C.normalizeServerUrl('https://a.com/api/v1/node').url, 'https://a.com');
  assert.equal(C.normalizeServerUrl('https://a.com/health').url, 'https://a.com');
  assert.equal(C.normalizeServerUrl('https://a.com/swagger').url, 'https://a.com');
  assert.equal(C.normalizeServerUrl('https://a.com/headscale/').url, 'https://a.com/headscale');
});
test('normalize: rejects bad input', () => {
  assert.equal(C.normalizeServerUrl('').ok, false);
  assert.equal(C.normalizeServerUrl('   ').ok, false);
  assert.equal(C.normalizeServerUrl('ftp://a.com').ok, false);
  assert.equal(C.normalizeServerUrl('a b.com').ok, false);
  assert.equal(C.normalizeServerUrl(null).ok, false);
});
test('sameServer ignores case and trailing slash', () => {
  assert.equal(C.sameServer('https://A.com/', 'a.com'), true);
  assert.equal(C.sameServer('https://a.com', 'https://b.com'), false);
});
test('apiUrl joins correctly', () => {
  assert.equal(C.apiUrl('https://a.com/', '/node'), 'https://a.com/api/v1/node');
  assert.equal(C.apiUrl('https://a.com', 'user'), 'https://a.com/api/v1/user');
});
test('extractAuthId: URL, bare id, junk', () => {
  assert.equal(C.extractAuthId('https://hs.example.com/register/AbC123xyz'), 'AbC123xyz');
  assert.equal(C.extractAuthId('  https://hs.example.com/register/AbC123xyz/?x=1  '), 'AbC123xyz');
  assert.equal(C.extractAuthId('AbC123xyz'), 'AbC123xyz');
  assert.equal(C.extractAuthId('abc'), '');
  assert.equal(C.extractAuthId('two words here'), '');
  assert.equal(C.extractAuthId(''), '');
  assert.equal(C.extractAuthId(null), '');
});
test('login commands contain the login server and optional key', () => {
  const c = C.buildLoginCommands('https://a.com', 'abc123');
  assert.match(c.linux, /--login-server https:\/\/a\.com --authkey abc123$/);
  assert.match(c.reset, /--reset/);
  assert.doesNotMatch(C.buildLoginCommands('https://a.com').linux, /authkey/);
});

/* ---------- parsing ---------- */
const nodesJson = {
  nodes: [
    { id: '2', name: 'pc-b', givenName: 'Zeta', user: { name: 'bob' }, ipAddresses: ['100.64.0.10', 'fd7a::2'], online: false, lastSeen: '2026-10-30T10:00:00Z', expiry: '0001-01-01T00:00:00Z', forcedTags: ['tag:srv'], validTags: ['tag:srv', 'tag:x'] },
    { id: '1', name: 'pc-a', givenName: 'alpha', user: { name: 'alice' }, ipAddresses: ['100.64.0.2'], online: true, lastSeen: '2026-11-01T10:00:00Z' },
    { id: '10', name: 'pc-c', user: { name: 'alice' }, ipAddresses: ['100.64.0.9'], online: true }
  ]
};
test('parseNodes: maps fields, falls back, dedups tags, null for year-1 time', () => {
  const n = C.parseNodes(nodesJson);
  assert.equal(n.length, 3);
  assert.equal(n[0].name, 'Zeta');
  assert.equal(n[0].hostname, 'pc-b');
  assert.equal(n[0].user, 'bob');
  assert.equal(n[0].expiry, null);
  assert.deepEqual(n[0].tags, ['tag:srv', 'tag:x']);
  assert.equal(n[2].name, 'pc-c');       // no givenName -> name
  assert.equal(n[2].lastSeen, null);
  assert.equal(n[1].online, true);
});
test('parseNodes: tolerant of garbage and legacy "machines" key', () => {
  assert.deepEqual(C.parseNodes(null), []);
  assert.deepEqual(C.parseNodes({}), []);
  assert.deepEqual(C.parseNodes({ nodes: 'x' }), []);
  assert.equal(C.parseNodes({ machines: [{ id: 5, name: 'm' }] })[0].id, '5');
});
test('parseNodes: accepts snake_case', () => {
  const n = C.parseNodes({ nodes: [{ id: '1', given_name: 'g', ip_addresses: ['100.64.0.1'], last_seen: '2026-01-01T00:00:00Z' }] })[0];
  assert.equal(n.name, 'g'); assert.deepEqual(n.ips, ['100.64.0.1']); assert.ok(n.lastSeen > 0);
});
test('parseUsers / parsePreAuthKeys / parseCreatedKey', () => {
  const u = C.parseUsers({ users: [{ id: '1', name: 'alice', displayName: 'Alice', email: 'a@x.io' }] });
  assert.equal(u[0].displayName, 'Alice');
  const k = C.parsePreAuthKeys({ preAuthKeys: [{ id: '3', key: 'k', user: { name: 'alice' }, reusable: true, used: false, expiration: '2026-12-01T00:00:00Z', aclTags: ['tag:a'] }] });
  assert.equal(k[0].user, 'alice'); assert.equal(k[0].reusable, true); assert.deepEqual(k[0].tags, ['tag:a']);
  assert.equal(C.parseCreatedKey({ preAuthKey: { key: 'secret' } }), 'secret');
  assert.equal(C.parseCreatedKey({}), '');
});

/* ---------- sorting & filtering ---------- */
test('sortNodes: by ip is numeric, not lexical', () => {
  const n = C.parseNodes(nodesJson);
  assert.deepEqual(C.sortNodes(n, 'ip', 'asc').map(x => x.ips[0]), ['100.64.0.2', '100.64.0.9', '100.64.0.10']);
  assert.deepEqual(C.sortNodes(n, 'ip', 'desc').map(x => x.ips[0]), ['100.64.0.10', '100.64.0.9', '100.64.0.2']);
});
test('sortNodes: by name is case-insensitive, does not mutate input', () => {
  const n = C.parseNodes(nodesJson); const before = n.map(x => x.id).join();
  assert.deepEqual(C.sortNodes(n, 'name', 'asc').map(x => x.name), ['alpha', 'pc-c', 'Zeta']);
  assert.equal(n.map(x => x.id).join(), before);
});
test('sortNodes: online desc puts online first, stable tie-break by name', () => {
  const n = C.parseNodes(nodesJson);
  assert.deepEqual(C.sortNodes(n, 'online', 'desc').map(x => x.name), ['pc-c', 'alpha', 'Zeta']);
});
test('sortNodes: lastSeen puts never-seen last when desc? (null=0 so first when asc)', () => {
  const n = C.parseNodes(nodesJson);
  assert.equal(C.sortNodes(n, 'lastSeen', 'asc')[0].name, 'pc-c');
  assert.equal(C.sortNodes(n, 'lastSeen', 'desc')[0].name, 'alpha');
});
test('filterNodes: query, multiple words, online-only, user', () => {
  const n = C.parseNodes(nodesJson);
  assert.equal(C.filterNodes(n, 'alice').length, 2);
  assert.equal(C.filterNodes(n, 'alice 0.2').length, 1);
  assert.equal(C.filterNodes(n, 'tag:srv').length, 1);
  assert.equal(C.filterNodes(n, '', { onlineOnly: true }).length, 2);
  assert.equal(C.filterNodes(n, '', { user: 'bob' }).length, 1);
  assert.equal(C.filterNodes(n, 'nomatch').length, 0);
});
test('summarize counts', () => {
  const s = C.summarize(C.parseNodes(nodesJson));
  assert.deepEqual(s, { total: 3, online: 2, offline: 1, expired: 0, users: 2 });
});

/* ---------- time ---------- */
test('relTime', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  assert.equal(C.relTime(null, now), '从未');
  assert.equal(C.relTime(now - 10e3, now), '刚刚');
  assert.equal(C.relTime(now - 5 * 60e3, now), '5分钟前');
  assert.equal(C.relTime(now - 3 * 3600e3, now), '3小时前');
  assert.equal(C.relTime(now - 3 * 86400e3, now), '3天前');
  assert.equal(C.relTime(now + 2 * 86400e3, now), '2天后');
});
test('parseTime: rejects zero/invalid', () => {
  assert.equal(C.parseTime('0001-01-01T00:00:00Z'), null);
  assert.equal(C.parseTime('garbage'), null);
  assert.equal(C.parseTime(''), null);
  assert.ok(C.parseTime('2026-01-01T00:00:00Z') > 0);
});

/* ---------- scheduler ---------- */
function fakeClock() {
  let t = 1000; const sleeps = [];
  return { now: () => t, sleep: (ms) => { sleeps.push(ms); t += ms; return Promise.resolve(); }, sleeps, advance: (ms) => { t += ms; } };
}
test('scheduler: serial execution with min interval', async () => {
  const clk = fakeClock();
  const s = C.createScheduler({ minInterval: 300, ttl: 0, now: clk.now, sleep: clk.sleep });
  let running = 0, maxRunning = 0; const starts = [];
  const task = (v) => async () => { running++; maxRunning = Math.max(maxRunning, running); starts.push(clk.now()); await Promise.resolve(); running--; return v; };
  const res = await Promise.all([s.run('a', task(1)), s.run('b', task(2)), s.run('c', task(3))]);
  assert.deepEqual(res, [1, 2, 3]);
  assert.equal(maxRunning, 1);
  assert.ok(starts[1] - starts[0] >= 300 && starts[2] - starts[1] >= 300, JSON.stringify(starts));
});
test('scheduler: identical in-flight requests are coalesced', async () => {
  const clk = fakeClock(); const s = C.createScheduler({ now: clk.now, sleep: clk.sleep });
  let calls = 0; const task = async () => { calls++; return 'x'; };
  const [a, b, c] = await Promise.all([s.run('k', task), s.run('k', task), s.run('k', task)]);
  assert.equal(calls, 1); assert.deepEqual([a, b, c], ['x', 'x', 'x']);
  assert.equal(s.stats().coalesced, 2);
});
test('scheduler: cache TTL, force, invalidate', async () => {
  const clk = fakeClock(); const s = C.createScheduler({ ttl: 10000, minInterval: 0, now: clk.now, sleep: clk.sleep });
  let calls = 0; const task = async () => ++calls;
  assert.equal(await s.run('k', task), 1);
  assert.equal(await s.run('k', task), 1);              // cached
  assert.equal(s.stats().cacheHits, 1);
  clk.advance(10001);
  assert.equal(await s.run('k', task), 2);              // expired
  assert.equal(await s.run('k', task, { force: true }), 3);
  s.invalidate('k');
  assert.equal(await s.run('k', task), 4);
  assert.equal(s.stats().network, 4);
});
test('scheduler: failure is not cached and does not break the chain', async () => {
  const clk = fakeClock(); const s = C.createScheduler({ minInterval: 0, now: clk.now, sleep: clk.sleep });
  await assert.rejects(s.run('k', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await s.run('k', async () => 'ok'), 'ok');
  assert.equal(s.stats().errors, 1);
});

/* ---------- storage & backup ---------- */
function memStorage(initial) { const m = Object.assign({}, initial); return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, _m: m }; }
test('store: roundtrip', () => {
  const st = C.createStore(memStorage());
  const s = C.defaultState();
  s.servers.push({ id: 'a', name: 'HS', url: 'hs.example.com', apiKey: 'k' });
  assert.equal(st.save(s), true);
  const back = st.load();
  assert.equal(back.servers[0].url, 'https://hs.example.com');
  assert.equal(back.activeId, 'a');
});
test('store: throwing storage never throws, falls back to memory', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const st = C.createStore(bad);
  assert.equal(st.load().servers.length, 0);
  const s = C.defaultState(); s.servers.push({ id: 'a', url: 'https://a.com' });
  assert.equal(st.save(s), false);
  assert.equal(st.load().servers.length, 1);            // memory fallback
});
test('store: corrupt JSON yields default state', () => {
  const st = C.createStore(memStorage({ 'myscale.v1': '{not json' }));
  assert.equal(st.load().servers.length, 0);
});
test('sanitizeState: drops invalid servers, repairs activeId, dedups ids, keeps default settings', () => {
  const s = C.sanitizeState({ servers: [{ id: 'x', url: 'a.com' }, { id: 'x', url: 'b.com' }, { id: 'y', url: 'ftp://bad' }, null], activeId: 'nope', settings: { theme: 'light' } });
  assert.equal(s.servers.length, 2);
  assert.notEqual(s.servers[0].id, s.servers[1].id);
  assert.equal(s.activeId, s.servers[0].id);
  assert.equal(s.settings.theme, 'light');
  assert.equal(s.settings.accent, 'indigo');
});
test('sanitizeState keeps the insecure (self-signed) flag only when strictly true', () => {
  const s = C.sanitizeState({ servers: [{ id: 'a', url: 'a.com', insecure: true }, { id: 'b', url: 'b.com', insecure: 'yes' }] });
  assert.equal(s.servers[0].insecure, true);
  assert.equal(s.servers[1].insecure, false);
});
test('backup: export/import roundtrip and key stripping', () => {
  const s = C.defaultState(); s.servers.push({ id: 'a', name: 'A', url: 'https://a.com', apiKey: 'SECRET' });
  const full = JSON.parse(C.exportBackup(s));
  assert.equal(full.state.servers[0].apiKey, 'SECRET'); assert.equal(full.keysIncluded, true);
  const stripped = JSON.parse(C.exportBackup(s, { stripKeys: true }));
  assert.equal(stripped.state.servers[0].apiKey, ''); assert.equal(stripped.keysIncluded, false);
  const r = C.importBackup(C.exportBackup(s), C.defaultState(), 'merge');
  assert.equal(r.ok, true); assert.equal(r.added, 1);
});
test('backup: merge skips duplicates; replace overwrites; rejects foreign files', () => {
  const cur = C.defaultState(); cur.servers.push({ id: 'a', name: 'A', url: 'https://a.com', apiKey: '' });
  const other = C.defaultState(); other.servers.push({ id: 'z', name: 'A2', url: 'a.com/', apiKey: '' }, { id: 'q', name: 'B', url: 'https://b.com', apiKey: '' });
  const text = C.exportBackup(other);
  const m = C.importBackup(text, cur, 'merge');
  assert.equal(m.added, 1); assert.equal(m.skipped, 1); assert.equal(m.state.servers.length, 2);
  const r = C.importBackup(text, cur, 'replace');
  assert.equal(r.state.servers.length, 2);
  assert.equal(C.importBackup('nope', cur, 'merge').ok, false);
  assert.equal(C.importBackup('{"app":"other"}', cur, 'merge').ok, false);
});

/* ---------- errors & masking ---------- */
test('describeHttpError', () => {
  assert.match(C.describeHttpError(401), /API Key/);
  assert.match(C.describeHttpError(404), /404/);
  assert.match(C.describeHttpError(429), /频繁/);
  assert.match(C.describeHttpError(502), /服务器/);
  assert.match(C.describeHttpError(400, '{"message":"bad user"}'), /bad user/);
});
test('maskKey', () => {
  assert.equal(C.maskKey(''), '');
  assert.equal(C.maskKey('abc'), '••••');
  assert.equal(C.maskKey('abcdef1234567890'), 'abcd••••890');
});

/* ---------- custom buttons / quick actions ---------- */
test('buttons: validate api button, normalizes path and method', () => {
  const r = C.validateButton({ label: ' 节点 ', kind: 'api', method: 'get', path: 'api/v1/node' });
  assert.equal(r.ok, true);
  assert.equal(r.button.label, '节点'); assert.equal(r.button.method, 'GET'); assert.equal(r.button.path, '/api/v1/node');
  assert.equal(r.button.body, ''); assert.ok(r.button.id);
});
test('buttons: only absolute server paths allowed (no scheme/host, no traversal, no spaces, no placeholders)', () => {
  for (const bad of ['https://evil.com/x', 'http://a', '//evil.com/x', '/a/../b', '/a b', '', '   ', '/api/v1/node/{id}', 'javascript:alert(1)']) {
    assert.equal(C.validateButton({ label: 'x', method: 'GET', path: bad }).ok, false, bad);
  }
  assert.equal(C.validateButton({ label: 'x', method: 'GET', path: '/api/v1/preauthkey?user=alice' }).ok, true);
});
test('buttons: label required, method whitelist, label clipped to 20', () => {
  assert.equal(C.validateButton({ label: '  ', path: '/health' }).ok, false);
  assert.equal(C.validateButton({ label: 'x', method: 'TRACE', path: '/health' }).ok, false);
  assert.equal(C.validateButton({ label: 'a'.repeat(40), path: '/health' }).button.label.length, 20);
  assert.equal(C.validateButton(null).ok, false);
});
test('buttons: writes always require confirmation; GET drops body', () => {
  assert.equal(C.validateButton({ label: 'd', method: 'DELETE', path: '/api/v1/node/3', confirm: false }).button.confirm, true);
  assert.equal(C.validateButton({ label: 'g', method: 'GET', path: '/health', body: '{"a":1}' }).button.body, '');
  assert.equal(C.validateButton({ label: 'g', method: 'GET', path: '/health' }).button.confirm, false);
});
test('buttons: body must be JSON, template tokens allowed inside it', () => {
  assert.equal(C.validateButton({ label: 'p', method: 'POST', path: '/api/v1/user', body: '{"name":' }).ok, false);
  assert.equal(C.validateButton({ label: 'p', method: 'POST', path: '/api/v1/user', body: '{"name":"bob"}' }).ok, true);
  assert.equal(C.validateButton({ label: 'p', method: 'POST', path: '/api/v1/preauthkey', body: '{"expiration":"{in7d}","user":{name}}' }).ok, true);
});
test('buttons: copy button needs template', () => {
  assert.equal(C.validateButton({ label: 'c', kind: 'copy', template: '' }).ok, false);
  const b = C.validateButton({ label: 'c', kind: 'copy', template: 'x {url}' }).button;
  assert.equal(b.kind, 'copy'); assert.equal(b.template, 'x {url}');
});
test('fillTemplate: known tokens replaced, unknown kept, dates computed from ctx.now', () => {
  const now = new Date('2026-03-04T05:06:07.000Z');
  const out = C.fillTemplate('{url} {host} {key} {name} {now} {in7d} {nope}', { url: 'https://a.com', host: 'a.com', key: 'K', name: 'hs', now });
  assert.equal(out, 'https://a.com a.com K hs 2026-03-04T05:06:07.000Z 2026-03-11T05:06:07.000Z {nope}');
  assert.equal(C.fillTemplate('{in1d}|{in30d}', { now }), '2026-03-05T05:06:07.000Z|2026-04-03T05:06:07.000Z');
  assert.equal(C.fillTemplate(null, {}), '');
  assert.match(C.fillTemplate('{date}', { now: new Date(2026, 0, 9) }), /^2026-01-09$/);
});
test('buttons: sanitizeButtons drops invalid, dedupes ids, caps at MAX', () => {
  const list = [{ id: 'a', label: 'one', path: '/health' }, { id: 'a', label: 'two', path: '/health' }, { label: '', path: '/x' }, 7, null];
  const out = C.sanitizeButtons(list);
  assert.equal(out.length, 2); assert.notEqual(out[0].id, out[1].id);
  const many = Array.from({ length: 60 }, (_, i) => ({ label: 'b' + i, path: '/health' }));
  assert.equal(C.sanitizeButtons(many).length, C.MAX_BUTTONS);
  assert.deepEqual(C.sanitizeButtons('nope'), []);
});
test('quick: sanitize keeps known tokens in order, drops unknown/dupes/orphans', () => {
  const btns = C.sanitizeButtons([{ id: 'k1', label: 'k', path: '/health' }]);
  assert.deepEqual(C.sanitizeQuick(['url', 'zzz', 'c:k1', 'url', 'c:gone', 'health'], btns), ['url', 'c:k1', 'health']);
  assert.deepEqual(C.sanitizeQuick([], btns), []);
  assert.deepEqual(C.sanitizeQuick('x', btns), []);
});
test('quick: default state has defaults; a stored empty list stays empty (user hid everything)', () => {
  assert.deepEqual(C.sanitizeState({}).quick, C.DEFAULT_QUICK);
  assert.deepEqual(C.sanitizeState({ quick: [] }).quick, []);
  assert.deepEqual(C.sanitizeState({ quick: ['url', 'bogus'] }).quick, ['url']);
  assert.ok(C.QUICK_BUILTINS.length >= 8 && C.QUICK_BUILTINS.every(x => x.id && x.label && x.icon));
});
test('quick: moveItem swaps within bounds and does not mutate', () => {
  const a = ['a', 'b', 'c'];
  assert.deepEqual(C.moveItem(a, 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(C.moveItem(a, 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(C.moveItem(a, 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(C.moveItem(a, 2, 1), ['a', 'b', 'c']);
  assert.deepEqual(a, ['a', 'b', 'c']);
});
test('presets: every preset is itself a valid button', () => {
  for (const p of C.BUTTON_PRESETS) assert.equal(C.validateButton(p).ok, true, p.label);
});
test('backup: custom buttons and layout survive export -> import(replace)', () => {
  const st = C.sanitizeState({ servers: [{ id: 's1', url: 'https://hs.test' }], buttons: [{ id: 'k1', label: '策略', path: '/api/v1/policy' }], quick: ['c:k1', 'url'] });
  const res = C.importBackup(C.exportBackup(st), C.defaultState(), 'replace');
  assert.equal(res.ok, true);
  assert.deepEqual(res.state.buttons.map(b => b.label), ['策略']);
  assert.deepEqual(res.state.quick, ['c:k1', 'url']);
});
test('backup: merge adds new custom buttons (shown), skips identical ones', () => {
  const cur = C.sanitizeState({ buttons: [{ id: 'a', label: '策略', path: '/api/v1/policy' }], quick: ['c:a'] });
  const inc = C.sanitizeState({ buttons: [{ id: 'a', label: '策略', path: '/api/v1/policy' }, { id: 'a', label: '用户', path: '/api/v1/user' }], quick: [] });
  const res = C.importBackup(C.exportBackup(inc), cur, 'merge');
  assert.equal(res.buttonsAdded, 1);
  assert.equal(res.state.buttons.length, 2);
  assert.equal(new Set(res.state.buttons.map(b => b.id)).size, 2);
  assert.equal(res.state.quick.length, 2);
  assert.ok(res.state.quick.every(t => res.state.buttons.some(b => 'c:' + b.id === t)));
});
test('backup: corrupted button list in storage does not break loading', () => {
  const storage = { v: JSON.stringify({ servers: [], buttons: 'oops', quick: { a: 1 } }), getItem() { return this.v; }, setItem() {} };
  const s = C.createStore(storage).load();
  assert.deepEqual(s.buttons, []); assert.deepEqual(s.quick, C.DEFAULT_QUICK);
});
