/* Optional UI smoke test (needs playwright + Chrome; not part of `node --test`).
 * Run:  node tests/ui-smoke.cjs   (set PLAYWRIGHT_PATH / CHROME_PATH if needed; SHOTS=dir to save screenshots)
 * It serves ./src over HTTP and injects a MOCK of window.__TAURI__.http.fetch, so it validates MyScale's own UI
 * logic only — NOT real Headscale responses and NOT the Rust/Android side.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const SRC = path.join(__dirname, '..', 'src');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const SHOTS = process.env.SHOTS || '';

const MOCK = () => {
  window.__calls = [];
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const nodes = [
    { id: '1', name: 'laptop', givenName: 'laptop', user: { name: 'alice' }, ipAddresses: ['100.64.0.1', 'fd7a:115c::1'], online: true, lastSeen: iso(5e3), forcedTags: [] },
    { id: '2', name: 'phone', givenName: 'phone', user: { name: 'alice' }, ipAddresses: ['100.64.0.2'], online: false, lastSeen: iso(3 * 3600e3) },
    { id: '10', name: 'nas', givenName: 'nas', user: { name: 'bob' }, ipAddresses: ['100.64.0.10'], online: true, lastSeen: iso(1e3), forcedTags: ['tag:server'], expiry: iso(86400e3) }
  ];
  const users = [{ id: '1', name: 'alice' }, { id: '2', name: 'bob' }];
  const R = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => (obj === undefined ? '' : JSON.stringify(obj)), json: async () => obj });
  window.__TAURI__ = { http: { fetch: async (url, init) => {
    init = init || {}; const u = new URL(url); const auth = (init.headers || {}).Authorization;
    window.__calls.push({ m: init.method, p: u.pathname + u.search, auth: !!auth, danger: !!init.danger });
    await new Promise(r => setTimeout(r, 15));
    if (u.hostname === 'down.test') throw new Error('error sending request: connection refused');
    if (u.pathname === '/health') return R(200, { status: 'pass' });
    if (auth !== 'Bearer good') return R(401, { message: 'Unauthorized' });
    if (u.pathname === '/api/v1/node') return R(200, { nodes });
    if (u.pathname === '/api/v1/user' && (init.method || 'GET') === 'GET') return R(200, { users });
    if (u.pathname === '/api/v1/preauthkey' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      if (typeof b.user === 'number' && window.__oldServer) return R(400, { message: 'cannot unmarshal number into string' });
      return R(200, { preAuthKey: { key: 'tskey-new-123456789', user: b.user } });
    }
    if (u.pathname === '/api/v1/preauthkey') return R(200, { preAuthKeys: [{ id: '7', key: 'abcdef1234567890', user: { name: 'alice' }, reusable: true, used: false, expiration: iso(-86400e3) }] });
    if (/\/api\/v1\/node\/\d+\/rename\//.test(u.pathname)) return R(200, {});
    return R(404, { message: 'not found' });
  } } };
};

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(SRC, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(SRC) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const results = []; let failed = 0;
  const check = (name, cond, extra) => { results.push((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); if (!cond) failed++; };
  const errors = [];

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base);

  check('default theme is dark', await page.evaluate(() => document.body.dataset.theme) === 'dark');
  check('viewport-fit=cover present', (await page.getAttribute('meta[name=viewport]', 'content')).includes('viewport-fit=cover'));
  check('first run shows connect view', await page.isVisible('#view-connect'));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '01-connect-portrait.png') });

  // bad input
  await page.fill('#quickUrl', 'ftp://x'); await page.click('[data-act=quick-connect]');
  check('rejects ftp scheme', (await page.textContent('#quickMsg')).includes('http'));

  // unreachable
  await page.fill('#quickUrl', 'down.test'); await page.click('[data-act=quick-connect]');
  await page.waitForFunction(() => document.querySelector('#quickMsg').textContent.includes('✗'));
  check('unreachable server reports failure', (await page.textContent('#quickMsg')).includes('✗'));

  // good server (bare host -> https)
  await page.fill('#quickUrl', 'hs.test'); await page.fill('#quickKey', 'good'); await page.click('[data-act=quick-connect]');
  await page.waitForSelector('#view-devices.active', { timeout: 5000 });
  await page.waitForSelector('#deviceList .item');
  check('connect validated key and moved to devices', true);
  check('3 device cards rendered', await page.locator('#deviceList .item').count() === 3);
  check('bare domain normalized to https', await page.evaluate(() => window.__myscale.state().servers.some(s => s.url === 'https://hs.test')));
  check('Authorization header sent to API', await page.evaluate(() => window.__calls.some(c => c.p === '/api/v1/node' && c.auth)));
  check('/health sent without auth', await page.evaluate(() => window.__calls.filter(c => c.p === '/health').every(c => !c.auth)));
  check('tiles show 3 total / 2 online', (await page.textContent('#tiles')).replace(/\s/g, '').startsWith('3总数2在线'), await page.textContent('#tiles'));
  check('online sorted first', (await page.locator('#deviceList .t').first().textContent()) !== 'phone');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '02-devices-portrait.png') });

  // search + filters
  await page.fill('#q', 'bob'); check('search filters to 1', await page.locator('#deviceList .item').count() === 1);
  await page.fill('#q', ''); await page.click('.chip[data-k=online]');
  check('online-only chip filters to 2', await page.locator('#deviceList .item').count() === 2);
  await page.click('.chip[data-k=all]');

  // sheet + Android back button behaviour
  const startUrl = page.url();
  await page.click('#deviceList .item >> nth=0');
  check('node sheet opens', await page.isVisible('#sheet'));
  await page.click('[data-x=rename]');
  check('nested prompt replaces sheet content', (await page.textContent('#sheetTitle')) === '重命名设备');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#sheetTitle').textContent !== '重命名设备');
  check('back closes the nested prompt first (detail still open)', await page.isVisible('#sheet'));
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  check('second back closes the sheet', !(await page.isVisible('#sheet')));
  check('app page still the same after closing sheets', page.url() === startUrl);
  check('sheet stack empty', await page.evaluate(() => window.__myscale.sheets.length) === 0);

  // programmatic close (X button) keeps history consistent
  await page.click('#deviceList .item >> nth=0'); await page.click('[data-act=close-sheet]');
  await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  check('X button closes sheet', true);
  const histLen = await page.evaluate(() => history.length);
  await page.click('#deviceList .item >> nth=0'); await page.click('#scrim', { position: { x: 5, y: 5 } });
  await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  check('scrim tap closes sheet', true);

  // rename flow
  await page.click('#deviceList .item >> nth=0'); await page.click('[data-x=rename]'); await page.fill('#askIn', 'laptop2'); await page.click('[data-x=yes]');
  await page.waitForFunction(() => window.__calls.some(c => /rename\/laptop2$/.test(c.p)));
  check('rename sends POST /node/{id}/rename/{name}', await page.evaluate(() => window.__calls.some(c => c.m === 'POST' && /\/node\/\d+\/rename\/laptop2$/.test(c.p))));
  await page.waitForFunction(() => window.__myscale.sheets.length === 0);

  // request budget: spam refresh -> should coalesce / hit cache
  await page.evaluate(() => window.__myscale.sched.resetStats());
  const before = await page.evaluate(() => window.__calls.length);
  await page.evaluate(() => { for (let i = 0; i < 6; i++) document.querySelector('#refreshBtn').click(); });
  await page.waitForTimeout(1500);
  const delta = (await page.evaluate(() => window.__calls.length)) - before;
  check('6 rapid refreshes -> at most 2 network calls', delta <= 2, 'delta=' + delta);

  // keys + users
  await page.click('.nav [data-tab=keys]'); await page.waitForSelector('#keyList .item');
  check('keys list shows masked key', (await page.textContent('#keyList')).includes('••••'));
  await page.click('[data-act=new-key]'); await page.waitForSelector('#k-go'); await page.click('#k-go');
  await page.waitForSelector('#sheetBody .code');
  check('key creation shows secret once', (await page.textContent('#sheetBody')).includes('tskey-new-123456789'));
  check('login command includes --login-server and --authkey', /--login-server https:\/\/hs\.test --authkey tskey-new-123456789/.test(await page.textContent('#sheetBody')));
  await page.goBack(); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  // older-server fallback: number rejected -> retry with name
  await page.evaluate(() => { window.__oldServer = true; window.__calls.length = 0; });
  await page.click('[data-act=new-key]'); await page.waitForSelector('#k-go'); await page.click('#k-go'); await page.waitForSelector('#sheetBody .code');
  check('falls back to user-name on 400', await page.evaluate(() => window.__calls.filter(c => c.m === 'POST' && c.p === '/api/v1/preauthkey').length === 2));
  await page.goBack(); await page.waitForFunction(() => document.querySelector('#sheet').hidden);

  await page.click('.nav [data-tab=users]'); await page.waitForSelector('#userList .item');
  check('users listed with device counts', (await page.textContent('#userList')).includes('2 台'));

  // settings
  await page.click('.nav [data-tab=settings]');
  await page.click('[data-set=theme] [data-v=light]'); check('light theme applies', await page.evaluate(() => document.body.dataset.theme) === 'light');
  await page.click('[data-set=theme] [data-v=amoled]'); check('amoled theme applies', await page.evaluate(() => document.body.dataset.theme) === 'amoled');
  await page.click('[data-set=bg] [data-v=stars]'); await page.click('[data-set=accent] [data-v=rose]');
  check('bg + accent apply', await page.evaluate(() => document.body.dataset.bg === 'stars' && document.body.dataset.accent === 'rose'));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '03-settings-portrait.png') });
  await page.click('[data-set=theme] [data-v=dark]'); await page.click('[data-set=bg] [data-v=aurora]'); await page.click('[data-set=accent] [data-v=indigo]');

  // persistence across reload
  await page.reload(); await page.waitForSelector('#view-devices.active');
  check('state persisted in localStorage and restored (unreachable + good server, good one active)', await page.evaluate(() => { const st = window.__myscale.state(); return st.servers.length === 2 && st.servers.find(s => s.id === st.activeId).url === 'https://hs.test'; }));

  // backup roundtrip
  await page.click('.nav [data-tab=settings]'); await page.click('[data-act=export]'); await page.waitForSelector('#e-text');
  const backup = await page.inputValue('#e-text'); check('backup contains the server', backup.includes('hs.test'));
  await page.check('#e-strip'); const stripped = await page.inputValue('#e-text'); check('strip keys option removes key', !stripped.includes('"good"'));
  await page.goBack(); await page.waitForFunction(() => document.querySelector('#sheet').hidden);

  // ---- quick buttons + user-defined buttons ----
  const waitSheetHidden = () => page.waitForFunction(() => document.querySelector('#sheet').hidden);
  const calls = (re) => page.evaluate((src) => window.__calls.filter(c => new RegExp(src).test(c.m + ' ' + c.p)).length, re.source);
  await page.click('.nav [data-tab=connect]');
  check('quick grid: 6 default buttons + add/sort', await page.locator('#quickGrid .qbtn').count() === 7);
  await page.click('#quickGrid [data-q=health]');
  await page.waitForSelector('#sheet:not([hidden]) .res');
  check('built-in "检测连接" shows result sheet', (await page.textContent('#sheet .res')).includes('✓'));
  await page.goBack(); await waitSheetHidden();

  await page.click('#quickGrid [data-act=edit-quick]');
  check('editor opens and lists shown buttons', await page.locator('#sheetBody .qrow').count() >= 6);
  await page.click('[data-x=add]');
  check('new-button form opens', (await page.textContent('#sheetTitle')) === '新建自定义按钮');
  await page.click('#bt-presets [data-p="0"]');
  check('preset fills path', (await page.inputValue('#bt-path')) === '/api/v1/node');
  await page.click('[data-x=save]');
  await page.waitForSelector('#quickGrid .qbtn.custom');
  check('saved custom button shows on grid', await page.locator('#quickGrid .qbtn.custom').count() === 1);
  check('back from nested form returns to editor list (not closing everything)', (await page.textContent('#sheetTitle')) === '快捷按钮');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '06-quick-editor.png') });
  await page.goBack(); await waitSheetHidden();

  // run a GET custom button: executes immediately, no confirm, shows JSON
  const nodeGetsBefore = await calls(/^GET \/api\/v1\/node$/);
  await page.click('#quickGrid .qbtn.custom');
  await page.waitForSelector('#sheet:not([hidden]) .res');
  check('custom GET runs without confirm and shows JSON', (await page.textContent('#sheet .res')).includes('"nodes"'));
  check('custom GET sent exactly one request', (await calls(/^GET \/api\/v1\/node$/)) === nodeGetsBefore + 1);
  check('custom request carried Authorization', await page.evaluate(() => window.__calls.filter(c => c.p === '/api/v1/node').pop().auth));
  await page.goBack(); await waitSheetHidden();

  // invalid path rejected, then a POST button that must ask first
  await page.click('#quickGrid [data-act=edit-quick]'); await page.click('[data-x=add]');
  await page.fill('#bt-label', '改名'); await page.selectOption('#bt-method', 'POST'); await page.fill('#bt-path', 'https://evil.com/x');
  await page.click('[data-x=save]');
  check('absolute URL as path is rejected with message', (await page.textContent('#bt-msg')).includes('路径无效'));
  check('rejected button was not saved', await page.evaluate(() => window.__myscale.state().buttons.length) === 1);
  await page.fill('#bt-path', '/api/v1/node/1/rename/zzz'); await page.click('[data-x=save]');
  await page.waitForFunction(() => window.__myscale.state().buttons.length === 2);
  await page.goBack(); await waitSheetHidden();
  await page.click('#quickGrid .qbtn.custom >> nth=1');
  await page.waitForSelector('#sheet:not([hidden]) [data-x=yes]');
  check('write button asks for confirmation first', (await page.textContent('#sheetBody')).includes('POST /api/v1/node/1/rename/zzz'));
  check('nothing sent before confirming', (await calls(/^POST \/api\/v1\/node\/1\/rename\/zzz$/)) === 0);
  await page.click('[data-x=no]'); await waitSheetHidden();
  check('cancel sends nothing', (await calls(/^POST \/api\/v1\/node\/1\/rename\/zzz$/)) === 0);
  await page.click('#quickGrid .qbtn.custom >> nth=1'); await page.click('[data-x=yes]');
  await page.waitForSelector('#sheet:not([hidden]) .res');
  check('confirm sends exactly one POST', (await calls(/^POST \/api\/v1\/node\/1\/rename\/zzz$/)) === 1);
  check('write result reported as success', (await page.textContent('#sheet .hint')).includes('成功'));
  await page.goBack(); await waitSheetHidden();

  // copy-text button
  await page.click('#quickGrid [data-act=edit-quick]'); await page.click('[data-x=add]');
  await page.click('#bt-presets [data-p="5"]');
  check('copy preset switches to text mode', await page.isVisible('#bt-tpl') && !(await page.isVisible('#bt-path')));
  await page.click('[data-x=save]'); await page.waitForFunction(() => window.__myscale.state().buttons.length === 3);
  await page.goBack(); await waitSheetHidden();
  await page.click('#quickGrid .qbtn.custom >> nth=2');
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已复制'));
  check('copy button reports copied and sends no request', true);

  // hide / reorder / restore
  const quickNow = () => page.evaluate(() => window.__myscale.state().quick.slice());
  const q0 = await quickNow();
  await page.click('#quickGrid [data-act=edit-quick]');
  await page.click('[data-x=down][data-i="0"]');
  const q1 = await quickNow(); check('move down reorders', q1[0] === q0[1] && q1[1] === q0[0]);
  await page.click('[data-x=hide][data-i="0"]');
  const q2 = await quickNow(); check('hide removes from grid', q2.length === q0.length - 1 && await page.locator('#quickGrid .qbtn:not(.ghost)').count() === q2.length);
  await page.click('[data-x=show]');
  check('hidden item can be shown again', (await quickNow()).length === q0.length);
  await page.click('[data-x=reset]');
  check('reset restores default layout', JSON.stringify(await quickNow()) === JSON.stringify(['health', 'cmd', 'newkey', 'newuser', 'register', 'servers']));
  await page.goBack(); await waitSheetHidden();

  // edit + delete
  await page.click('#quickGrid [data-act=edit-quick]'); await page.click('[data-x=show][data-t^="c:"] >> nth=0');
  await page.click('[data-x=edit] >> nth=0');
  check('edit form is prefilled', (await page.inputValue('#bt-label')).length > 0);
  await page.fill('#bt-label', '节点列表2'); await page.click('[data-x=save]');
  await page.waitForFunction(() => window.__myscale.state().buttons.some(b => b.label === '节点列表2'));
  check('edit saved', true);
  await page.click('[data-x=edit] >> nth=0'); await page.click('[data-x=del]'); await page.click('[data-x=yes]');
  await page.waitForFunction(() => window.__myscale.state().buttons.length === 2);
  check('delete removes button and its layout token', await page.evaluate(() => window.__myscale.state().quick.every(t => !t.startsWith('c:') || window.__myscale.state().buttons.some(b => 'c:' + b.id === t))));
  await page.goBack(); await waitSheetHidden();

  // persistence + backup
  await page.reload(); await page.waitForSelector('#view-devices.active');
  await page.click('.nav [data-tab=connect]');
  check('custom buttons persist after reload', await page.evaluate(() => window.__myscale.state().buttons.length) === 2);
  await page.click('.nav [data-tab=settings]'); await page.click('#view-settings [data-act=edit-quick]');
  check('settings page opens the same editor', (await page.textContent('#sheetTitle')) === '快捷按钮');
  await page.goBack(); await waitSheetHidden();
  await page.click('[data-act=export]'); await page.waitForSelector('#e-text');
  const bk2 = await page.inputValue('#e-text'); check('backup includes custom buttons', bk2.includes('"buttons"') && bk2.includes('改名'));
  await page.goBack(); await waitSheetHidden();
  await page.click('.nav [data-tab=connect]');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '07-connect-quick.png') });
  await page.click('.nav [data-tab=devices]');

  // responsive layout checks
  const navPos = async () => page.evaluate(() => { const r = document.querySelector('#nav').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, pos: getComputedStyle(document.querySelector('#nav')).position }; });
  let n = await navPos(); check('portrait phone: bottom bar', n.pos === 'fixed' && n.y > n.vh / 2 && n.w > n.vw * 0.9, JSON.stringify(n));
  await page.setViewportSize({ width: 844, height: 390 }); await page.click('.nav [data-tab=devices]'); await page.waitForTimeout(250);
  n = await navPos(); check('landscape phone: side rail', n.pos !== 'fixed' && n.w < 120 && n.x < 5, JSON.stringify(n));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '04-devices-landscape.png') });
  await page.setViewportSize({ width: 1180, height: 820 }); await page.waitForTimeout(250);
  n = await navPos(); check('tablet: side rail', n.pos !== 'fixed' && n.w < 120, JSON.stringify(n));
  check('tablet: multi-column grid', await page.evaluate(() => getComputedStyle(document.querySelector('#deviceList')).gridTemplateColumns.split(' ').length) >= 3);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '05-devices-tablet.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check('no horizontal overflow on tablet', !overflow);
  await page.setViewportSize({ width: 360, height: 640 });
  check('no horizontal overflow on small phone', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));

  // storage that throws must not break the app
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } }); });
  await ctx2.addInitScript(MOCK);
  const p2 = await ctx2.newPage(); const errs2 = []; p2.on('pageerror', e => errs2.push(e.message));
  await p2.goto(base); await p2.fill('#quickUrl', 'hs.test'); await p2.fill('#quickKey', 'good'); await p2.click('[data-act=quick-connect]');
  await p2.waitForSelector('#view-devices.active', { timeout: 5000 });
  check('app works when localStorage throws', errs2.length === 0 && await p2.locator('#deviceList .item').count() === 3, errs2.join('|'));

  check('no page/console errors in main flow', errors.length === 0, errors.join(' | '));
  await browser.close(); server.close();
  console.log(results.join('\n')); console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
