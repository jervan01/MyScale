/* MyScale UI. Network goes through window.__TAURI__.http.fetch (Rust side) when available; falls back to window.fetch in a plain browser. */
(function () {
  'use strict';
  var C = window.MyScaleCore;

  /* ---------- tiny helpers ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function ic(n) { return '<svg class="ic"><use href="#i-' + n + '"/></svg>'; }

  var storage = (function () {
    try { var t = '__myscale_t'; window.localStorage.setItem(t, '1'); window.localStorage.removeItem(t); return window.localStorage; }
    catch (e) { return { getItem: function () { return null; }, setItem: function () { throw new Error('no storage'); }, removeItem: function () { } }; }
  })();
  var store = C.createStore(storage);
  var state = store.load();
  var storageWarned = false;
  function save() {
    if (!store.save(state) && !storageWarned) { storageWarned = true; toast('本机存储不可用，数据只在本次运行内有效'); }
  }

  var sched = C.createScheduler({ minInterval: 350, ttl: 15000 });
  var ui = { tab: 'connect', q: '', onlineOnly: false, user: '', nodes: null, users: null, keys: null, err: {}, loading: {}, health: {}, lastRefresh: 0, reveal: {} };

  function active() {
    for (var i = 0; i < state.servers.length; i++) if (state.servers[i].id === state.activeId) return state.servers[i];
    return null;
  }
  function serverById(id) { for (var i = 0; i < state.servers.length; i++) if (state.servers[i].id === id) return state.servers[i]; return null; }

  /* ---------- toast / clipboard ---------- */
  var toastTimer = 0;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function legacyCopy(t) {
    try {
      var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch (e) { return false; }
  }
  function copyText(t, label) {
    function done(ok) { toast(ok ? (label || '已复制') : '复制失败，请长按文本手动复制'); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(legacyCopy(t)); });
        return;
      }
    } catch (e) { /* fall through */ }
    done(legacyCopy(t));
  }

  /* ---------- settings ---------- */
  var ACCENTS = { indigo: '#6366f1', cyan: '#06b6d4', emerald: '#10b981', rose: '#f43f5e', amber: '#f59e0b', violet: '#8b5cf6' };
  function applySettings() {
    var st = state.settings, b = document.body;
    var theme = st.theme;
    if (theme === 'auto') theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    b.dataset.theme = theme; b.dataset.accent = st.accent; b.dataset.bg = st.bg; b.dataset.density = st.density;
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f5fb' : theme === 'amoled' ? '#000000' : '#0b0d14');
    $$('[data-set]').forEach(function (g) {
      var key = g.dataset.set;
      if (key === 'accent') return;
      $$('button', g).forEach(function (btn) { btn.classList.toggle('on', String(st[key]) === btn.dataset.v); });
    });
    $$('.swatches button').forEach(function (btn) { btn.classList.toggle('on', btn.dataset.v === st.accent); });
    $('#sortKey').value = st.sortKey;
    scheduleAuto();
  }
  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if (state.settings.theme === 'auto') applySettings(); }); } catch (e) { /* old webview */ }
  }

  /* ---------- network ---------- */
  function tauriFetch() { var t = window.__TAURI__; return t && t.http && typeof t.http.fetch === 'function' ? t.http.fetch : null; }
  function netHint(err, server) {
    var m = String(err && err.message || err || '');
    if (/cert|ssl|tls|handshake|unknown ca|self.signed/i.test(m)) return '证书校验失败。若是自签名证书，请在服务器设置里开启「允许自签名证书」。\n' + m;
    if (/dns|resolve|lookup|not known/i.test(m)) return '无法解析域名，请检查地址与网络。\n' + m;
    if (/refused|unreachable|timed out|timeout|connect/i.test(m)) return '无法连接到服务器，请检查地址、端口、防火墙与网络。\n' + m;
    if (/not allowed|scope|forbidden by|url not allowed/i.test(m)) return '该域名未被应用放行（capabilities 的 http 白名单）。请参考 README 修改 capabilities/default.json 后重新编译。\n' + m;
    if (!tauriFetch() && /failed to fetch|networkerror|load failed/i.test(m)) return '浏览器预览模式下受跨域限制，请在 APK 内使用。\n' + m;
    return '网络请求失败：' + m;
  }
  async function request(server, method, path, body, opts) {
    opts = opts || {};
    var url = opts.absolute || C.apiUrl(server.url, path);
    var headers = { Accept: 'application/json' };
    if (!opts.noAuth && server.apiKey) headers.Authorization = 'Bearer ' + server.apiKey;
    var init = { method: method, headers: headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, opts.timeout || 15000);
    init.signal = ctl.signal;
    var tf = tauriFetch();
    if (tf) {
      init.connectTimeout = 10000;
      if (server.insecure) init.danger = { acceptInvalidCerts: true, acceptInvalidHostnames: true };
    }
    if (!tf && window.__TAURI_INTERNALS__) throw new Error('检测到 Tauri 环境，但 window.__TAURI__.http 不存在：请确认 tauri.conf.json 中 app.withGlobalTauri 为 true，且 Rust 端已注册 tauri-plugin-http。');
    var f = tf || (window.fetch ? window.fetch.bind(window) : null);
    if (!f) throw new Error('当前环境不支持网络请求');
    var res, text;
    try {
      res = await f(url, init);
      text = await res.text();
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('请求超时（15 秒）');
      throw new Error(netHint(err, server));
    } finally { clearTimeout(timer); }
    if (!res.ok) { var e = new Error(C.describeHttpError(res.status, text)); e.status = res.status; throw e; }
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (e2) { var e3 = new Error('服务器返回的不是 JSON：地址可能指向了网页或反向代理拦截了 /api。'); e3.status = 200; throw e3; }
  }
  function apiGet(server, path, o) {
    return sched.run(server.id + '|' + path, function () { return request(server, 'GET', path); }, o);
  }
  async function apiWrite(server, method, path, body) {
    try {
      return await sched.run(server.id + '|W|' + method + '|' + path + '|' + Date.now(), function () { return request(server, method, path, body); }, { force: true });
    } finally { sched.invalidate(server.id + '|'); }
  }

  /* ---------- connection test ---------- */
  async function testServer(server) {
    var lines = [], level = 'ok';
    var reachable = false;
    try {
      await sched.run(server.url + '|health', function () { return request(server, 'GET', '', undefined, { absolute: server.url + '/health', noAuth: true, timeout: 10000 }); }, { force: true });
      reachable = true; lines.push('✓ 服务器可达（/health 正常）');
    } catch (e) {
      if (e.status === 404 || e.status === 200) { reachable = true; lines.push('· 服务器可达，但 /health 不可用（' + e.status + '），继续检查 API'); }
      else if (e.status) { reachable = true; lines.push('· 服务器返回 ' + e.status + '，继续检查 API'); }
      else { lines.push('✗ ' + e.message); level = 'bad'; }
    }
    var authOk = null;
    if (reachable && server.apiKey) {
      try {
        var j = await sched.run(server.id + '|/user', function () { return request(server, 'GET', '/user'); }, { force: true });
        var n = C.parseUsers(j).length; authOk = true;
        lines.push('✓ API Key 有效（' + n + ' 个用户）');
      } catch (e2) { authOk = false; level = 'bad'; lines.push('✗ ' + e2.message); }
    } else if (reachable) {
      lines.push('· 未填写 API Key：仅能生成登录命令，无法管理设备');
      level = 'warn';
    }
    var ok = reachable && authOk !== false;
    ui.health[server.id] = { ok: ok, t: Date.now() };
    if (ok && serverById(server.id)) { serverById(server.id).lastOk = Date.now(); save(); }
    renderChip();
    return { ok: ok, authOk: authOk, level: ok && level === 'bad' ? 'warn' : level, text: lines.join('\n') };
  }

  /* ---------- sheet stack (Android back closes the sheet first) ---------- */
  var sheets = [];
  var popWaiters = [];
  function paintSheet() {
    var d = sheets[sheets.length - 1];
    var sc = $('#scrim'), sh = $('#sheet');
    if (!d) { sc.hidden = true; sh.hidden = true; $('#sheetBody').innerHTML = ''; return; }
    sc.hidden = false; sh.hidden = false;
    $('#sheetTitle').textContent = d.title;
    var body = $('#sheetBody'); body.innerHTML = ''; body.scrollTop = 0;
    d.render(body);
  }
  function showSheet(d) {
    sheets.push(d);
    try { history.pushState({ sheet: sheets.length }, ''); } catch (e) { /* ignore */ }
    paintSheet();
  }
  function closeSheet() {
    return new Promise(function (res) {
      if (!sheets.length) return res();
      popWaiters.push(res);
      try { history.back(); } catch (e) { onPop(); }
      setTimeout(res, 700);
    });
  }
  function onPop() {
    if (sheets.length) { var d = sheets.pop(); if (d.onClose) { try { d.onClose(); } catch (e) { /* ignore */ } } paintSheet(); }
    while (popWaiters.length) popWaiters.shift()();
  }
  window.addEventListener('popstate', onPop);
  try { history.replaceState({ root: 1 }, ''); } catch (e) { /* ignore */ }
  async function closeAllSheets() { while (sheets.length) await closeSheet(); }

  function confirmBox(title, msg, okLabel, danger) {
    return new Promise(function (resolve) {
      var settled = false;
      showSheet({
        title: title,
        render: function (b) {
          b.innerHTML = '<p>' + esc(msg).replace(/\n/g, '<br>') + '</p><div class="actions"><button class="btn" data-x="no">取消</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-x="yes">' + esc(okLabel || '确定') + '</button></div>';
          $('[data-x="no"]', b).onclick = function () { closeSheet(); };
          $('[data-x="yes"]', b).onclick = function () { settled = true; closeSheet().then(function () { resolve(true); }); };
        },
        onClose: function () { if (!settled) { settled = true; resolve(false); } }
      });
    });
  }
  function askText(o) {
    return new Promise(function (resolve) {
      var settled = false;
      showSheet({
        title: o.title,
        render: function (b) {
          b.innerHTML = '<div class="field"><label>' + esc(o.label || '') + '</label><input id="askIn" type="' + (o.type || 'text') + '" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(o.value || '') + '" placeholder="' + esc(o.placeholder || '') + '"></div><div class="actions"><button class="btn" data-x="no">取消</button><button class="btn primary" data-x="yes">' + esc(o.ok || '确定') + '</button></div>';
          var inp = $('#askIn', b);
          function submit() { var v = inp.value.trim(); if (!v) { inp.focus(); return; } settled = true; closeSheet().then(function () { resolve(v); }); }
          $('[data-x="no"]', b).onclick = function () { closeSheet(); };
          $('[data-x="yes"]', b).onclick = submit;
          inp.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
        },
        onClose: function () { if (!settled) { settled = true; resolve(null); } }
      });
    });
  }

  /* ---------- header chip ---------- */
  function renderChip() {
    var s = active();
    $('#chipName').textContent = s ? s.name : '未连接';
    var h = s && ui.health[s.id];
    $('#chipDot').className = 'dot' + (h ? (h.ok ? ' ok' : ' bad') : '');
  }

  /* ---------- connect view ---------- */
  function cmdFor(which) {
    var s = active(); if (!s) return '';
    var k = $('#cmdKey').value.trim();
    var c = C.buildLoginCommands(s.url, k);
    return which === 'reset' ? c.reset : c.linux;
  }
  function renderConnect() {
    renderQuick();
    var list = $('#serverList');
    if (!state.servers.length) {
      list.innerHTML = '<div class="empty"><b>还没有服务器</b>在上方输入地址，或点「添加」。</div>';
    } else {
      list.innerHTML = state.servers.map(function (s) {
        var h = ui.health[s.id];
        return '<div class="item' + (s.id === state.activeId ? ' active-server' : '') + '" data-act="pick-server" data-id="' + esc(s.id) + '">' +
          '<div class="avatar">' + esc((s.name || '?').charAt(0).toUpperCase()) + '</div>' +
          '<div class="body"><div class="t">' + esc(s.name) + '</div><div class="s">' + esc(s.url) + '</div>' +
          '<div>' + (s.id === state.activeId ? '<span class="tag ok">当前</span>' : '') +
          (s.apiKey ? '<span class="tag">已存 Key</span>' : '<span class="tag warn">无 Key</span>') +
          (s.insecure ? '<span class="tag bad">允许自签名</span>' : '') +
          (h ? (h.ok ? '<span class="tag ok">可达</span>' : '<span class="tag bad">不可达</span>') : '') + '</div></div>' +
          '<button class="icon-btn" data-act="edit-server" data-id="' + esc(s.id) + '" aria-label="编辑">' + ic('edit') + '</button></div>';
      }).join('');
    }
    var s = active();
    $('#cmdCard').hidden = !s;
    if (s) $('#cmdLinux').textContent = cmdFor('linux');
  }

  async function quickConnect() {
    var urlIn = $('#quickUrl').value, key = $('#quickKey').value.trim();
    var msg = $('#quickMsg');
    var n = C.normalizeServerUrl(urlIn);
    if (!n.ok) { msg.className = 'hint bad'; msg.textContent = n.error; return; }
    var s = null;
    for (var i = 0; i < state.servers.length; i++) if (C.sameServer(state.servers[i].url, n.url)) s = state.servers[i];
    if (s) { if (key) s.apiKey = key; }
    else {
      s = { id: uid(), name: n.host, url: n.url, apiKey: key, note: '', createdAt: Date.now(), lastOk: 0, color: '', insecure: false };
      state.servers.push(s);
    }
    state.activeId = s.id; save();
    ui.nodes = ui.users = ui.keys = null; ui.err = {};
    msg.className = 'hint'; msg.textContent = '正在检测…';
    renderChip(); renderConnect();
    var r = await testServer(s);
    msg.className = 'hint ' + r.level; msg.textContent = r.text;
    if (!r.ok && /证书/.test(r.text)) msg.textContent += '\n（可在服务器设置里开启「允许自签名证书」）';
    renderConnect();
    if (r.ok) { $('#quickUrl').value = ''; $('#quickKey').value = ''; }
    if (r.ok && r.authOk) { toast('已连接 ' + s.name); setTimeout(function () { setTab('devices'); }, 600); }
  }

  function pickServer(id) {
    if (!serverById(id)) return;
    state.activeId = id; save();
    ui.nodes = ui.users = ui.keys = null; ui.err = {};
    renderChip(); renderConnect(); renderCurrent();
    toast('已切换到 ' + serverById(id).name);
    refreshCurrent(false);
  }

  function serverSheet(id) {
    var editing = id ? serverById(id) : null;
    var d = editing ? JSON.parse(JSON.stringify(editing)) : { name: '', url: '', apiKey: '', note: '', insecure: false };
    showSheet({
      title: editing ? '编辑服务器' : '添加服务器',
      render: function (b) {
        b.innerHTML =
          '<div class="field"><label>名称</label><input id="f-name" value="' + esc(d.name) + '" placeholder="留空则用主机名"></div>' +
          '<div class="field"><label>后端地址（http / https）</label><input id="f-url" type="url" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(d.url) + '" placeholder="hs.example.com 或 http://192.168.1.5:8080"></div>' +
          '<div class="field"><label>API Key</label><div class="field-row" style="margin-top:0"><input id="f-key" type="password" autocomplete="off" spellcheck="false" value="' + esc(d.apiKey) + '"><button class="icon-btn" id="f-eye" aria-label="显示/隐藏">' + ic('eye') + '</button></div></div>' +
          '<label class="check"><input type="checkbox" id="f-insecure"' + (d.insecure ? ' checked' : '') + '> 允许自签名 / 无效证书（不安全）</label>' +
          '<div class="field"><label>备注</label><input id="f-note" value="' + esc(d.note) + '"></div>' +
          '<p class="hint" id="f-msg"></p>' +
          '<div class="actions"><button class="btn" id="f-test">' + ic('bolt') + '测试</button><button class="btn primary" id="f-save">' + ic('check') + '保存</button>' +
          (editing ? '<button class="btn danger" id="f-del">' + ic('trash') + '删除</button>' : '') + '</div>';
        function read() {
          var n = C.normalizeServerUrl($('#f-url', b).value);
          return { n: n, name: $('#f-name', b).value.trim(), apiKey: $('#f-key', b).value.trim(), insecure: $('#f-insecure', b).checked, note: $('#f-note', b).value.trim() };
        }
        var msg = $('#f-msg', b);
        $('#f-eye', b).onclick = function () { var k = $('#f-key', b); k.type = k.type === 'password' ? 'text' : 'password'; };
        $('#f-test', b).onclick = async function () {
          var v = read(); if (!v.n.ok) { msg.className = 'hint bad'; msg.textContent = v.n.error; return; }
          msg.className = 'hint'; msg.textContent = '正在检测…';
          var r = await testServer({ id: id || '_tmp', url: v.n.url, apiKey: v.apiKey, insecure: v.insecure });
          msg.className = 'hint ' + r.level; msg.textContent = r.text;
        };
        $('#f-save', b).onclick = async function () {
          var v = read(); if (!v.n.ok) { msg.className = 'hint bad'; msg.textContent = v.n.error; return; }
          var dup = state.servers.some(function (x) { return x.id !== id && C.sameServer(x.url, v.n.url); });
          if (dup) { msg.className = 'hint bad'; msg.textContent = '已存在相同地址的服务器'; return; }
          var s = editing;
          if (!s) { s = { id: uid(), createdAt: Date.now(), lastOk: 0, color: '' }; state.servers.push(s); }
          s.name = v.name || v.n.host; s.url = v.n.url; s.apiKey = v.apiKey; s.insecure = v.insecure; s.note = v.note;
          if (!state.activeId || !editing) state.activeId = s.id;
          sched.invalidate(s.id + '|'); save();
          await closeSheet(); renderChip(); renderConnect(); renderCurrent(); toast('已保存');
          refreshCurrent(true);
        };
        if (editing) $('#f-del', b).onclick = async function () {
          var ok = await confirmBox('删除服务器', '确定删除「' + editing.name + '」？本机保存的地址和 API Key 将被移除（不影响服务器本身）。', '删除', true);
          if (!ok) return;
          state.servers = state.servers.filter(function (x) { return x.id !== id; });
          if (state.activeId === id) state.activeId = state.servers[0] ? state.servers[0].id : '';
          save(); ui.nodes = ui.users = ui.keys = null;
          await closeAllSheets(); renderChip(); renderConnect(); renderCurrent(); toast('已删除');
        };
      }
    });
  }

  function serverSwitcher() {
    showSheet({
      title: '切换服务器',
      render: function (b) {
        var html = state.servers.map(function (s) {
          return '<div class="item' + (s.id === state.activeId ? ' active-server' : '') + '" data-pick="' + esc(s.id) + '" style="margin-bottom:8px"><div class="avatar">' + esc(s.name.charAt(0).toUpperCase()) + '</div><div class="body"><div class="t">' + esc(s.name) + '</div><div class="s">' + esc(s.url) + '</div></div></div>';
        }).join('');
        b.innerHTML = (html || '<div class="empty"><b>还没有服务器</b></div>') + '<div class="actions"><button class="btn" data-x="add">' + ic('plus') + '添加服务器</button><button class="btn" data-x="manage">管理</button></div>';
        $$('[data-pick]', b).forEach(function (el) { el.onclick = async function () { var id = el.dataset.pick; await closeSheet(); pickServer(id); }; });
        $('[data-x="add"]', b).onclick = async function () { await closeSheet(); serverSheet(null); };
        $('[data-x="manage"]', b).onclick = async function () { await closeSheet(); setTab('connect'); };
      }
    });
  }

  /* ---------- need-key / error helpers ---------- */
  function needServer(el) {
    el.innerHTML = '<div class="empty"><b>还没有连接服务器</b>先到「连接」页输入后端地址。<br><br><button class="btn primary" data-tab="connect">去连接</button></div>';
  }
  function needKey(el) {
    el.innerHTML = '<div class="empty"><b>需要 API Key</b>在 Headscale 服务器上执行 <code>headscale apikeys create</code> 生成，然后填入服务器设置。<br><br><button class="btn primary" data-act="edit-server" data-id="' + esc(state.activeId) + '">填写 API Key</button></div>';
  }
  function errBox(el, msg, retry) {
    el.innerHTML = '<div class="empty"><b>加载失败</b><span style="white-space:pre-line">' + esc(msg) + '</span><br><br><button class="btn" data-act="refresh">重试</button></div>';
  }
  function skeletons(el, n) { var h = ''; for (var i = 0; i < n; i++) h += '<div class="skeleton"></div>'; el.innerHTML = h; }

  /* ---------- devices ---------- */
  async function loadNodes(force) {
    var s = active(); if (!s || !s.apiKey) { ui.nodes = null; renderDevices(); return; }
    ui.loading.nodes = true; if (!ui.nodes) renderDevices();
    try { ui.nodes = C.parseNodes(await apiGet(s, '/node', { force: force })); ui.err.nodes = ''; ui.health[s.id] = { ok: true, t: Date.now() }; }
    catch (e) { ui.err.nodes = e.message; if (!e.status || e.status >= 500) ui.health[s.id] = { ok: false, t: Date.now() }; }
    ui.loading.nodes = false; renderChip(); renderDevices();
  }
  function renderDevices() {
    var s = active();
    var list = $('#deviceList'), tiles = $('#tiles'), chips = $('#chips');
    if (!s) { tiles.innerHTML = chips.innerHTML = ''; needServer(list); return; }
    if (!s.apiKey) { tiles.innerHTML = chips.innerHTML = ''; needKey(list); return; }
    if (ui.err.nodes && !ui.nodes) { tiles.innerHTML = chips.innerHTML = ''; errBox(list, ui.err.nodes); return; }
    if (!ui.nodes) { tiles.innerHTML = chips.innerHTML = ''; skeletons(list, 4); return; }
    var sum = C.summarize(ui.nodes);
    tiles.innerHTML = [['总数', sum.total], ['在线', sum.online], ['离线', sum.offline], ['已过期', sum.expired]].map(function (t) { return '<div class="tile"><b>' + t[1] + '</b><span>' + t[0] + '</span></div>'; }).join('');
    var users = {}; ui.nodes.forEach(function (n) { if (n.user) users[n.user] = 1; });
    var h = '<button class="chip' + (!ui.onlineOnly && !ui.user ? ' on' : '') + '" data-act="chip" data-k="all">全部</button><button class="chip' + (ui.onlineOnly ? ' on' : '') + '" data-act="chip" data-k="online">仅在线</button>';
    Object.keys(users).sort().forEach(function (u) { h += '<button class="chip' + (ui.user === u ? ' on' : '') + '" data-act="chip" data-k="user" data-u="' + esc(u) + '">' + esc(u) + '</button>'; });
    chips.innerHTML = h;
    var rows = C.sortNodes(C.filterNodes(ui.nodes, ui.q, { onlineOnly: ui.onlineOnly, user: ui.user }), state.settings.sortKey, state.settings.sortDir);
    if (!rows.length) { list.innerHTML = '<div class="empty"><b>' + (ui.nodes.length ? '没有匹配的设备' : '这个服务器上还没有设备') + '</b>' + (ui.nodes.length ? '换个关键词或清除筛选。' : '在「连接」页复制登录命令，到客户端执行即可加入。') + '</div>'; return; }
    var now = Date.now();
    list.innerHTML = rows.map(function (n) {
      var expired = n.expiry && n.expiry < now;
      return '<div class="item" data-act="node" data-id="' + esc(n.id) + '"><div class="avatar' + (n.online ? '' : ' off') + '">' + esc(n.name.charAt(0).toUpperCase()) + '</div>' +
        '<div class="body"><div class="t">' + esc(n.name) + '</div><div class="s">' + esc(n.ips[0] || '无 IP') + (n.user ? ' · ' + esc(n.user) : '') + '</div>' +
        '<div>' + n.tags.slice(0, 3).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + (expired ? '<span class="tag bad">已过期</span>' : '') + '</div></div>' +
        '<div style="text-align:right">' + (n.online ? '<span class="tag ok">在线</span>' : '<span class="s muted small">' + esc(C.relTime(n.lastSeen)) + '</span>') + '</div></div>';
    }).join('');
  }
  function kv(k, v) { return '<div class="kv"><span>' + esc(k) + '</span><span>' + (v === '' || v == null ? '—' : v) + '</span></div>'; }
  function fmtDate(ts) { return ts ? new Date(ts).toLocaleString() + '（' + C.relTime(ts) + '）' : '—'; }
  function nodeSheet(id) {
    var n = (ui.nodes || []).filter(function (x) { return x.id === id; })[0]; if (!n) return;
    showSheet({
      title: n.name,
      render: function (b) {
        var now = Date.now();
        b.innerHTML =
          kv('状态', n.online ? '<span class="tag ok">在线</span>' : '<span class="tag">离线</span>') +
          kv('主机名', esc(n.hostname)) + kv('用户', esc(n.user)) +
          n.ips.map(function (ip, i) { return '<div class="kv" data-copy="' + esc(ip) + '" style="cursor:pointer"><span>' + (ip.indexOf(':') >= 0 ? 'IPv6' : 'IPv4') + ' · 点击复制</span><span>' + esc(ip) + '</span></div>'; }).join('') +
          kv('最后在线', esc(fmtDate(n.lastSeen))) +
          kv('密钥过期', n.expiry ? esc(fmtDate(n.expiry)) + (n.expiry < now ? ' <span class="tag bad">已过期</span>' : '') : '永不') +
          kv('创建时间', esc(fmtDate(n.createdAt))) +
          kv('注册方式', esc(n.method)) +
          kv('标签', n.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('')) +
          '<div class="actions">' +
          '<button class="btn" data-x="cp">' + ic('copy') + '复制 IP</button>' +
          '<button class="btn" data-x="rename">' + ic('edit') + '重命名</button>' +
          '<button class="btn" data-x="expire">' + ic('power') + '使其过期</button>' +
          '<button class="btn danger" data-x="del">' + ic('trash') + '删除设备</button></div>';
        $$('[data-copy]', b).forEach(function (el) { el.onclick = function () { copyText(el.dataset.copy); }; });
        $('[data-x="cp"]', b).onclick = function () { copyText(n.ips.join('\n') || n.name, '已复制 ' + n.ips.length + ' 个 IP'); };
        var s = active();
        $('[data-x="rename"]', b).onclick = async function () {
          var v = await askText({ title: '重命名设备', label: '新名称（小写字母、数字、连字符）', value: n.name, ok: '重命名' });
          if (!v) return;
          try { await apiWrite(s, 'POST', '/node/' + encodeURIComponent(n.id) + '/rename/' + encodeURIComponent(v)); toast('已重命名'); await closeAllSheets(); loadNodes(true); }
          catch (e) { toast(e.message.split('\n')[0]); }
        };
        $('[data-x="expire"]', b).onclick = async function () {
          if (!await confirmBox('使密钥过期', '「' + n.name + '」将断开，需要重新登录认证。继续？', '使其过期', true)) return;
          try { await apiWrite(s, 'POST', '/node/' + encodeURIComponent(n.id) + '/expire'); toast('已过期'); await closeAllSheets(); loadNodes(true); }
          catch (e) { toast(e.message.split('\n')[0]); }
        };
        $('[data-x="del"]', b).onclick = async function () {
          if (!await confirmBox('删除设备', '确定从服务器删除「' + n.name + '」？此操作不可撤销。', '删除', true)) return;
          try { await apiWrite(s, 'DELETE', '/node/' + encodeURIComponent(n.id)); toast('已删除'); await closeAllSheets(); loadNodes(true); }
          catch (e) { toast(e.message.split('\n')[0]); }
        };
      }
    });
  }
  async function registerSheet() {
    var s = active(); if (!s || !s.apiKey) { toast('需要先配置服务器与 API Key'); return; }
    if (!ui.users) await loadUsers(false);
    var users = ui.users || [];
    showSheet({
      title: '注册设备',
      render: function (b) {
        b.innerHTML = '<p class="muted small">在客户端执行 <code>tailscale up --login-server ' + esc(s.url) + '</code>，把输出的 /register/… 链接（或其中的 ID）粘贴到这里。</p>' +
          '<div class="field"><label>注册链接或 ID</label><input id="r-id" autocapitalize="off" spellcheck="false"></div>' +
          '<div class="field"><label>分配给用户</label><select id="r-user" style="width:100%">' + users.map(function (u) { return '<option value="' + esc(u.name) + '">' + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
          '<p class="hint" id="r-msg"></p><div class="actions"><button class="btn primary" id="r-go">注册</button></div>';
        $('#r-go', b).onclick = async function () {
          var id = C.extractAuthId($('#r-id', b).value), user = $('#r-user', b).value, msg = $('#r-msg', b);
          if (!id) { msg.className = 'hint bad'; msg.textContent = '无法识别注册 ID'; return; }
          if (!user) { msg.className = 'hint bad'; msg.textContent = '请先创建用户'; return; }
          try { await apiWrite(s, 'POST', '/auth/register', { user: user, authId: id }); toast('已提交注册'); await closeSheet(); loadNodes(true); }
          catch (e) { msg.className = 'hint bad'; msg.textContent = e.message + '\n（此接口按新版文档实现；旧版本使用 /node/register，尚未适配）'; }
        };
      }
    });
  }

  /* ---------- users ---------- */
  async function loadUsers(force) {
    var s = active(); if (!s || !s.apiKey) { ui.users = null; renderUsers(); return; }
    ui.loading.users = true; if (!ui.users) renderUsers();
    try { ui.users = C.parseUsers(await apiGet(s, '/user', { force: force })); ui.err.users = ''; }
    catch (e) { ui.err.users = e.message; }
    ui.loading.users = false; renderUsers();
  }
  function renderUsers() {
    var s = active(), el = $('#userList');
    if (!s) return needServer(el); if (!s.apiKey) return needKey(el);
    if (ui.err.users && !ui.users) return errBox(el, ui.err.users);
    if (!ui.users) return skeletons(el, 3);
    if (!ui.users.length) { el.innerHTML = '<div class="empty"><b>还没有用户</b>点右上角「新建用户」。</div>'; return; }
    var count = {}; (ui.nodes || []).forEach(function (n) { count[n.user] = (count[n.user] || 0) + 1; });
    el.innerHTML = ui.users.map(function (u) {
      return '<div class="item" data-act="user" data-id="' + esc(u.id) + '"><div class="avatar">' + esc((u.name || '?').charAt(0).toUpperCase()) + '</div><div class="body"><div class="t">' + esc(u.name) + '</div><div class="s">' + esc(u.displayName || u.email || ('ID ' + u.id)) + '</div></div>' +
        (ui.nodes ? '<span class="tag">' + (count[u.name] || 0) + ' 台</span>' : '') + '</div>';
    }).join('');
  }
  function userSheet(id) {
    var u = (ui.users || []).filter(function (x) { return x.id === id; })[0]; if (!u) return;
    showSheet({
      title: u.name,
      render: function (b) {
        b.innerHTML = kv('ID', esc(u.id)) + kv('名称', esc(u.name)) + kv('显示名', esc(u.displayName)) + kv('邮箱', esc(u.email)) + kv('创建时间', esc(fmtDate(u.createdAt))) +
          '<div class="actions"><button class="btn" data-x="key">' + ic('key') + '为其生成密钥</button><button class="btn danger" data-x="del">' + ic('trash') + '删除用户</button></div>';
        $('[data-x="key"]', b).onclick = async function () { await closeSheet(); keySheet(u.name); };
        $('[data-x="del"]', b).onclick = async function () {
          if (!await confirmBox('删除用户', '确定删除用户「' + u.name + '」？其下设备需要为空，否则服务器会拒绝。', '删除', true)) return;
          try { await apiWrite(active(), 'DELETE', '/user/' + encodeURIComponent(u.id)); toast('已删除'); await closeAllSheets(); loadUsers(true); }
          catch (e) { toast(e.message.split('\n')[0]); }
        };
      }
    });
  }
  function newUserSheet() {
    var s = active(); if (!s || !s.apiKey) { toast('需要先配置服务器与 API Key'); return; }
    showSheet({
      title: '新建用户',
      render: function (b) {
        b.innerHTML = '<div class="field"><label>用户名（小写字母、数字、连字符）</label><input id="u-name" autocapitalize="off" spellcheck="false"></div><div class="field"><label>显示名（可选）</label><input id="u-disp"></div><div class="field"><label>邮箱（可选）</label><input id="u-mail" type="email"></div><p class="hint" id="u-msg"></p><div class="actions"><button class="btn primary" id="u-go">创建</button></div>';
        $('#u-go', b).onclick = async function () {
          var name = $('#u-name', b).value.trim(), msg = $('#u-msg', b);
          if (!name) { msg.className = 'hint bad'; msg.textContent = '请输入用户名'; return; }
          var body = { name: name }; var dn = $('#u-disp', b).value.trim(), em = $('#u-mail', b).value.trim();
          if (dn) body.displayName = dn; if (em) body.email = em;
          try { await apiWrite(s, 'POST', '/user', body); toast('已创建'); await closeSheet(); loadUsers(true); }
          catch (e) { msg.className = 'hint bad'; msg.textContent = e.message; }
        };
      }
    });
  }

  /* ---------- pre-auth keys ---------- */
  async function loadKeys(force) {
    var s = active(); if (!s || !s.apiKey) { ui.keys = null; renderKeys(); return; }
    ui.loading.keys = true; if (!ui.keys) renderKeys();
    try {
      try { ui.keys = C.parsePreAuthKeys(await apiGet(s, '/preauthkey', { force: force })); }
      catch (e) {
        // Older servers require ?user=<name>. Fall back to one serial request per user.
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403) {
          if (!ui.users) await loadUsers(false);
          var all = [];
          for (var i = 0; i < (ui.users || []).length; i++) {
            all = all.concat(C.parsePreAuthKeys(await apiGet(s, '/preauthkey?user=' + encodeURIComponent(ui.users[i].name), { force: force })));
          }
          ui.keys = all;
        } else throw e;
      }
      ui.err.keys = '';
    } catch (e2) { ui.err.keys = e2.message; }
    ui.loading.keys = false; renderKeys();
  }
  function renderKeys() {
    var s = active(), el = $('#keyList');
    if (!s) return needServer(el); if (!s.apiKey) return needKey(el);
    if (ui.err.keys && !ui.keys) return errBox(el, ui.err.keys);
    if (!ui.keys) return skeletons(el, 3);
    if (!ui.keys.length) { el.innerHTML = '<div class="empty"><b>没有预授权密钥</b>点右上角「生成密钥」，用于无人值守地加入设备。</div>'; return; }
    var now = Date.now();
    el.innerHTML = ui.keys.map(function (k) {
      var expired = k.expiration && k.expiration < now;
      var shown = state.settings.maskKeys && !ui.reveal[k.id] ? C.maskKey(k.key) : k.key;
      return '<div class="item" data-act="keyitem" data-id="' + esc(k.id) + '"><div class="avatar' + (expired || k.used && !k.reusable ? ' off' : '') + '">' + ic('key').replace('class="ic"', 'class="ic" style="width:22px;height:22px"') + '</div><div class="body"><div class="t">' + esc(shown || ('密钥 #' + k.id)) + '</div><div class="s">' + esc(k.user || '') + ' · ' + (k.expiration ? (expired ? '已过期' : esc(C.relTime(k.expiration)) + '过期') : '不过期') + '</div>' +
        '<div>' + (k.reusable ? '<span class="tag">可复用</span>' : '<span class="tag">一次性</span>') + (k.ephemeral ? '<span class="tag warn">临时</span>' : '') + (k.used ? '<span class="tag">已使用</span>' : '') + (expired ? '<span class="tag bad">已过期</span>' : '') + k.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div></div></div>';
    }).join('');
  }
  function keyItemSheet(id) {
    var k = (ui.keys || []).filter(function (x) { return x.id === id; })[0]; if (!k) return;
    showSheet({
      title: '预授权密钥',
      render: function (b) {
        var s = active();
        b.innerHTML = kv('用户', esc(k.user)) + kv('可复用', k.reusable ? '是' : '否') + kv('临时节点', k.ephemeral ? '是' : '否') + kv('已使用', k.used ? '是' : '否') + kv('过期时间', k.expiration ? esc(fmtDate(k.expiration)) : '不过期') +
          (k.key ? '<div class="code">' + esc(state.settings.maskKeys ? C.maskKey(k.key) : k.key) + '</div><div class="actions"><button class="btn" data-x="cp">' + ic('copy') + '复制密钥</button><button class="btn" data-x="cmd">复制登录命令</button></div>' : '<p class="muted small">此服务器没有返回完整密钥（新版本只在创建时显示一次）。</p>');
        if (k.key) {
          $('[data-x="cp"]', b).onclick = function () { copyText(k.key, '已复制密钥'); };
          $('[data-x="cmd"]', b).onclick = function () { copyText(C.buildLoginCommands(s.url, k.key).linux, '已复制命令'); };
        }
      }
    });
  }
  async function keySheet(presetUser) {
    var s = active(); if (!s || !s.apiKey) { toast('需要先配置服务器与 API Key'); return; }
    if (!ui.users) await loadUsers(false);
    var users = ui.users || [];
    if (!users.length) { toast('请先创建用户'); return; }
    showSheet({
      title: '生成预授权密钥',
      render: function (b) {
        b.innerHTML = '<div class="field"><label>用户</label><select id="k-user" style="width:100%">' + users.map(function (u) { return '<option value="' + esc(u.id) + '"' + (u.name === presetUser ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
          '<div class="field"><label>有效期</label><select id="k-exp" style="width:100%"><option value="1">1 小时</option><option value="24" selected>24 小时</option><option value="168">7 天</option><option value="720">30 天</option><option value="2160">90 天</option></select></div>' +
          '<label class="check"><input type="checkbox" id="k-reuse"> 可复用</label><label class="check"><input type="checkbox" id="k-eph"> 临时节点（离线后自动删除）</label>' +
          '<div class="field"><label>ACL 标签（可选，逗号分隔，如 tag:server）</label><input id="k-tags" autocapitalize="off" spellcheck="false"></div>' +
          '<p class="hint" id="k-msg"></p><div class="actions"><button class="btn primary" id="k-go">' + ic('key') + '生成</button></div>';
        $('#k-go', b).onclick = async function () {
          var msg = $('#k-msg', b), uSel = $('#k-user', b);
          var uid_ = uSel.value, uname = uSel.options[uSel.selectedIndex].text;
          var tags = $('#k-tags', b).value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
          var base = { reusable: $('#k-reuse', b).checked, ephemeral: $('#k-eph', b).checked, expiration: C.toIsoDuration($('#k-exp', b).value) };
          if (tags.length) base.aclTags = tags;
          msg.className = 'hint'; msg.textContent = '正在生成…';
          var res;
          try {
            try { res = await apiWrite(s, 'POST', '/preauthkey', Object.assign({ user: /^\d+$/.test(uid_) ? Number(uid_) : uid_ }, base)); }
            catch (e1) {
              // Older servers take the user NAME as a string.
              if (e1.status === 400 || e1.status === 500) res = await apiWrite(s, 'POST', '/preauthkey', Object.assign({ user: uname }, base));
              else throw e1;
            }
          } catch (e) { msg.className = 'hint bad'; msg.textContent = e.message; return; }
          var key = C.parseCreatedKey(res);
          if (!key) { msg.className = 'hint bad'; msg.textContent = '服务器没有返回密钥（响应格式未识别）'; return; }
          await closeSheet(); loadKeys(true); newKeyResult(key);
        };
      }
    });
  }
  function newKeyResult(key) {
    var s = active();
    showSheet({
      title: '密钥已生成',
      render: function (b) {
        var c = C.buildLoginCommands(s.url, key);
        b.innerHTML = '<p class="hint warn">请立即保存——新版服务器只显示这一次。</p><div class="code">' + esc(key) + '</div><div class="code">' + esc(c.linux) + '</div>' +
          '<div class="actions"><button class="btn" data-x="k">' + ic('copy') + '复制密钥</button><button class="btn primary" data-x="c">复制登录命令</button></div>';
        $('[data-x="k"]', b).onclick = function () { copyText(key, '已复制密钥'); };
        $('[data-x="c"]', b).onclick = function () { copyText(c.linux, '已复制命令'); };
      }
    });
  }


  /* ---------- quick buttons (built-in + user-defined) ---------- */
  function builtinById(id) { var L = C.QUICK_BUILTINS; for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i]; return null; }
  function buttonById(id) { for (var i = 0; i < state.buttons.length; i++) if (state.buttons[i].id === id) return state.buttons[i]; return null; }
  function describeToken(t) {
    if (t.indexOf('c:') === 0) {
      var b = buttonById(t.slice(2)); if (!b) return null;
      return { label: b.label, icon: b.kind === 'copy' ? 'copy' : 'bolt', custom: true, sub: b.kind === 'copy' ? '复制文本' : b.method + ' ' + b.path };
    }
    var d = builtinById(t); return d ? { label: d.label, icon: d.icon, custom: false, sub: '内置' } : null;
  }
  function renderQuick() {
    var h = state.quick.map(function (t) {
      var d = describeToken(t); if (!d) return '';
      return '<button class="qbtn' + (d.custom ? ' custom' : '') + '" data-act="quick" data-q="' + esc(t) + '">' + ic(d.icon) + '<span>' + esc(d.label) + '</span></button>';
    }).join('');
    h += '<button class="qbtn ghost" data-act="edit-quick">' + ic('plus') + '<span>添加 / 排序</span></button>';
    $('#quickGrid').innerHTML = h;
  }
  function hostOf(u) { try { return new URL(u).host; } catch (e) { return ''; } }
  function resultSheet(title, text, ok, meta) {
    showSheet({
      title: title,
      render: function (b) {
        b.innerHTML = '<p class="hint ' + (ok ? 'ok' : 'bad') + '" style="margin-top:0"></p><pre class="code res"></pre><div class="actions"><button class="btn" data-x="cp">' + ic('copy') + '复制结果</button><button class="btn primary" data-x="ok">关闭</button></div>';
        $('.hint', b).textContent = meta || (ok ? '成功' : '失败');
        $('.res', b).textContent = text;
        $('[data-x="cp"]', b).onclick = function () { copyText(text, '已复制结果'); };
        $('[data-x="ok"]', b).onclick = function () { closeSheet(); };
      }
    });
  }
  async function runCustom(b) {
    var s = active();
    var ctx = { url: s ? s.url : '', host: s ? hostOf(s.url) : '', key: s ? s.apiKey : '', name: s ? s.name : '', now: new Date() };
    if (b.kind === 'copy') { copyText(C.fillTemplate(b.template, ctx), '已复制：' + b.label); return; }
    if (!s) { toast('请先添加服务器'); return; }
    var path = b.path, body = b.body ? C.fillTemplate(b.body, ctx) : undefined, parsed;
    if (body !== undefined) { try { parsed = JSON.parse(body); } catch (e) { resultSheet(b.label, '请求体在替换占位符后不是有效 JSON：\n' + body, false, '未发送'); return; } }
    if (b.confirm || b.method !== 'GET') {
      var go = await confirmBox(b.label, b.method + ' ' + path + (body ? '\n' + body : '') + '\n\n发送到：' + s.name + '（' + s.url + '）', '执行', b.method === 'DELETE');
      if (!go) return;
    }
    toast('请求中…');
    try {
      var j = await sched.run(s.id + '|C|' + b.id + '|' + Date.now(), function () { return request(s, b.method, '', parsed, { absolute: s.url + path }); }, { force: true });
      if (b.method !== 'GET') { sched.invalidate(s.id + '|'); ui.nodes = ui.users = ui.keys = null; }
      resultSheet(b.label, JSON.stringify(j, null, 2).slice(0, 30000), true, b.method + ' ' + path + ' → 成功');
    } catch (e) { resultSheet(b.label, e.message, false, b.method + ' ' + path + ' → 失败'); }
    renderStats();
  }
  async function runQuick(t) {
    if (t.indexOf('c:') === 0) { var cb = buttonById(t.slice(2)); if (cb) await runCustom(cb); return; }
    var s = active();
    if (!s && (t === 'health' || t === 'cmd' || t === 'url')) { toast('请先添加服务器'); return; }
    if (t === 'health') { toast('检测中…'); var r = await testServer(s); resultSheet('连接检测', r.text, r.ok, s.name + (r.ok ? ' · 正常' : ' · 异常')); renderStats(); }
    else if (t === 'cmd') copyText(cmdFor('linux'), '已复制登录命令');
    else if (t === 'url') copyText(s.url, '已复制地址');
    else if (t === 'newkey') keySheet();
    else if (t === 'newuser') newUserSheet();
    else if (t === 'register') registerSheet();
    else if (t === 'servers') serverSwitcher();
    else if (t === 'refresh') { sched.invalidate(); refreshCurrent(true); }
    else if (t === 'export') exportSheet();
  }
  function quickEditor() {
    showSheet({
      title: '快捷按钮',
      render: function (b) {
        function draw() {
          var shown = state.quick.map(function (t, i) {
            var d = describeToken(t); if (!d) return '';
            return '<div class="qrow"><span class="ico">' + ic(d.icon) + '</span><div class="body"><div class="t">' + esc(d.label) + '</div><div class="s">' + esc(d.sub) + '</div></div>' +
              '<button class="icon-btn" data-x="up" data-i="' + i + '" aria-label="上移"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
              '<button class="icon-btn" data-x="down" data-i="' + i + '" aria-label="下移"' + (i === state.quick.length - 1 ? ' disabled' : '') + '>↓</button>' +
              (d.custom ? '<button class="icon-btn" data-x="edit" data-t="' + esc(t) + '" aria-label="编辑">' + ic('edit') + '</button>' : '') +
              '<button class="icon-btn" data-x="hide" data-i="' + i + '" aria-label="隐藏">' + ic('eye') + '</button></div>';
          }).join('');
          var hiddenTokens = C.QUICK_BUILTINS.map(function (x) { return x.id; }).concat(state.buttons.map(function (x) { return 'c:' + x.id; })).filter(function (t) { return state.quick.indexOf(t) < 0; });
          var hid = hiddenTokens.map(function (t) {
            var d = describeToken(t); if (!d) return '';
            return '<div class="qrow"><span class="ico">' + ic(d.icon) + '</span><div class="body"><div class="t">' + esc(d.label) + '</div><div class="s">' + esc(d.sub) + '</div></div>' +
              (d.custom ? '<button class="icon-btn" data-x="edit" data-t="' + esc(t) + '" aria-label="编辑">' + ic('edit') + '</button>' : '') +
              '<button class="btn small" data-x="show" data-t="' + esc(t) + '">显示</button></div>';
          }).join('');
          b.innerHTML = '<h4 style="margin-top:0">已显示（' + state.quick.length + '）</h4>' + (shown || '<p class="muted small">没有显示任何按钮。</p>') +
            (hid ? '<h4>已隐藏</h4>' + hid : '') +
            '<div class="actions"><button class="btn primary" data-x="add">' + ic('plus') + '新建自定义按钮</button><button class="btn" data-x="reset">恢复默认布局</button></div>' +
            '<p class="hint">自定义按钮：' + state.buttons.length + ' / ' + C.MAX_BUTTONS + '。</p>';
          $$('[data-x]', b).forEach(function (el) {
            el.onclick = function () {
              var x = el.dataset.x, i = Number(el.dataset.i), t = el.dataset.t;
              if (x === 'up' || x === 'down') state.quick = C.moveItem(state.quick, i, x === 'up' ? -1 : 1);
              else if (x === 'hide') state.quick.splice(i, 1);
              else if (x === 'show') state.quick.push(t);
              else if (x === 'reset') state.quick = C.DEFAULT_QUICK.slice();
              else if (x === 'edit') { buttonEditor(buttonById(t.slice(2))); return; }
              else if (x === 'add') { if (state.buttons.length >= C.MAX_BUTTONS) { toast('自定义按钮已达上限'); return; } buttonEditor(null); return; }
              save(); renderQuick(); draw();
            };
          });
        }
        draw();
      }
    });
  }
  function buttonEditor(ex) {
    var kind = ex ? ex.kind : 'api';
    showSheet({
      title: ex ? '编辑按钮' : '新建自定义按钮',
      render: function (b) {
        var presets = C.BUTTON_PRESETS.map(function (p, i) { return '<button class="chip" data-p="' + i + '">' + esc(p.label) + '</button>'; }).join('');
        b.innerHTML =
          (ex ? '' : '<h4 style="margin-top:0">从示例开始</h4><div class="chips wrap" id="bt-presets">' + presets + '</div>') +
          '<div class="field"><label for="bt-label">按钮名称（最多 20 字）</label><input id="bt-label" maxlength="20" autocomplete="off" placeholder="例如：读取 ACL 策略"></div>' +
          '<div class="setting" style="border:0"><span>类型</span><div class="seg" id="bt-kind"><button data-v="api">调用接口</button><button data-v="copy">复制文本</button></div></div>' +
          '<div id="bt-api">' +
            '<div class="field"><label for="bt-method">请求方法</label><select id="bt-method">' + C.METHODS.map(function (m) { return '<option>' + m + '</option>'; }).join('') + '</select></div>' +
            '<div class="field"><label for="bt-path">接口路径（只写服务器后面的部分，不带域名）</label><input id="bt-path" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="/api/v1/node"></div>' +
            '<div class="field"><label for="bt-body">请求体 JSON（可选，GET 忽略）</label><textarea id="bt-body" rows="4" spellcheck="false" placeholder="{&quot;name&quot;:&quot;alice&quot;}"></textarea></div>' +
            '<label class="check"><input type="checkbox" id="bt-confirm"> 执行前确认（POST/PUT/PATCH/DELETE 始终会确认）</label>' +
          '</div>' +
          '<div id="bt-copy"><div class="field"><label for="bt-tpl">要复制的文本（可用占位符）</label><textarea id="bt-tpl" rows="4" spellcheck="false" placeholder="tailscale up --login-server={url}"></textarea></div></div>' +
          '<p class="hint">占位符：{url} {host} {key} {name} {now} {date} {in1d} {in7d} {in30d}（{key} 是当前服务器的 API Key，注意别泄露）。</p>' +
          '<p class="hint" id="bt-msg"></p>' +
          '<div class="actions"><button class="btn" data-x="try">试运行</button><button class="btn primary" data-x="save">' + ic('check') + '保存</button>' + (ex ? '<button class="btn danger" data-x="del">' + ic('trash') + '删除</button>' : '') + '</div>';
        function setKind(k) { kind = k; $$('#bt-kind button', b).forEach(function (x) { x.classList.toggle('on', x.dataset.v === k); }); $('#bt-api', b).hidden = k !== 'api'; $('#bt-copy', b).hidden = k !== 'copy'; }
        function fill(o) {
          $('#bt-label', b).value = o.label || ''; setKind(o.kind === 'copy' ? 'copy' : 'api');
          $('#bt-method', b).value = o.method || 'GET'; $('#bt-path', b).value = o.path || '/api/v1/';
          $('#bt-body', b).value = o.body || ''; $('#bt-confirm', b).checked = o.confirm === true; $('#bt-tpl', b).value = o.template || '';
        }
        function read() {
          return { id: ex ? ex.id : undefined, label: $('#bt-label', b).value, kind: kind, method: $('#bt-method', b).value, path: $('#bt-path', b).value,
            body: $('#bt-body', b).value, confirm: $('#bt-confirm', b).checked, template: $('#bt-tpl', b).value };
        }
        fill(ex || { kind: 'api', method: 'GET', path: '/api/v1/' });
        $$('#bt-kind button', b).forEach(function (x) { x.onclick = function () { setKind(x.dataset.v); }; });
        $$('#bt-presets [data-p]', b).forEach(function (x) { x.onclick = function () { fill(C.BUTTON_PRESETS[Number(x.dataset.p)]); }; });
        var msg = $('#bt-msg', b);
        $('[data-x="try"]', b).onclick = function () { var r = C.validateButton(read()); if (!r.ok) { msg.className = 'hint bad'; msg.textContent = r.error; return; } msg.textContent = ''; runCustom(r.button); };
        $('[data-x="save"]', b).onclick = async function () {
          var r = C.validateButton(read());
          if (!r.ok) { msg.className = 'hint bad'; msg.textContent = r.error; return; }
          if (ex) { state.buttons = state.buttons.map(function (x) { return x.id === ex.id ? r.button : x; }); }
          else {
            while (buttonById(r.button.id)) r.button.id += 'x';
            state.buttons.push(r.button); state.quick.push('c:' + r.button.id);
          }
          save(); renderQuick(); await closeSheet(); toast('已保存「' + r.button.label + '」');
        };
        var del = $('[data-x="del"]', b);
        if (del) del.onclick = async function () {
          if (!await confirmBox('删除按钮', '删除「' + ex.label + '」？', '删除', true)) return;
          state.buttons = state.buttons.filter(function (x) { return x.id !== ex.id; });
          state.quick = state.quick.filter(function (t) { return t !== 'c:' + ex.id; });
          save(); renderQuick(); await closeSheet(); toast('已删除');
        };
      }
    });
  }

  /* ---------- settings / backup ---------- */
  function renderStats() {
    var st = sched.stats();
    $('#stats').innerHTML = [['网络请求', st.network], ['缓存命中', st.cacheHits], ['合并', st.coalesced], ['失败', st.errors], ['调用总数', st.calls]].map(function (x) { return '<div><b>' + x[1] + '</b><span>' + x[0] + '</span></div>'; }).join('');
  }
  function exportSheet() {
    showSheet({
      title: '导出备份',
      render: function (b) {
        b.innerHTML = '<label class="check" style="margin-top:0"><input type="checkbox" id="e-strip"> 不包含 API Key</label><div class="field"><textarea id="e-text" readonly></textarea></div>' +
          '<div class="actions"><button class="btn primary" data-x="cp">' + ic('copy') + '复制</button><button class="btn" data-x="dl">' + ic('download') + '下载文件</button></div><p class="hint">备份含 API Key 时请妥善保管。若「下载」没有反应，请使用「复制」。</p>';
        var ta = $('#e-text', b), strip = $('#e-strip', b);
        function fill() { ta.value = C.exportBackup(state, { stripKeys: strip.checked }); }
        strip.onchange = fill; fill();
        $('[data-x="cp"]', b).onclick = function () { copyText(ta.value, '备份已复制'); };
        $('[data-x="dl"]', b).onclick = function () {
          try {
            var blob = new Blob([ta.value], { type: 'application/json' }), a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = 'myscale-backup-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
            toast('已触发下载（若无反应请改用复制）');
          } catch (e) { toast('下载失败，请使用复制'); }
        };
      }
    });
  }
  function importSheet() {
    showSheet({
      title: '导入备份',
      render: function (b) {
        b.innerHTML = '<div class="field"><label>粘贴备份 JSON，或选择文件</label><textarea id="i-text"></textarea></div><input type="file" id="i-file" accept=".json,application/json,text/plain" style="margin-top:8px">' +
          '<div class="setting" style="border:0"><span>方式</span><div class="seg" id="i-mode"><button data-v="merge" class="on">合并</button><button data-v="replace">覆盖</button></div></div><p class="hint" id="i-msg"></p><div class="actions"><button class="btn primary" id="i-go">' + ic('upload') + '导入</button></div>';
        var mode = 'merge';
        $$('#i-mode button', b).forEach(function (btn) { btn.onclick = function () { mode = btn.dataset.v; $$('#i-mode button', b).forEach(function (x) { x.classList.toggle('on', x === btn); }); }; });
        $('#i-file', b).onchange = function (e) { var f = e.target.files && e.target.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { $('#i-text', b).value = String(r.result || ''); }; r.onerror = function () { toast('读取文件失败'); }; r.readAsText(f); };
        $('#i-go', b).onclick = async function () {
          var msg = $('#i-msg', b), res = C.importBackup($('#i-text', b).value, state, mode);
          if (!res.ok) { msg.className = 'hint bad'; msg.textContent = res.error; return; }
          if (mode === 'replace' && !await confirmBox('覆盖现有数据', '将用备份替换本机全部服务器与设置。继续？', '覆盖', true)) return;
          state = res.state; save(); sched.invalidate(); ui.nodes = ui.users = ui.keys = null; ui.health = {};
          await closeAllSheets(); applySettings(); renderChip(); renderConnect(); renderCurrent(); toast('导入完成：服务器新增 ' + res.added + '，跳过 ' + res.skipped + (res.buttonsAdded ? '，按钮新增 ' + res.buttonsAdded : ''));
        };
      }
    });
  }

  /* ---------- tabs / refresh ---------- */
  function renderCurrent() {
    renderChip();
    if (ui.tab === 'connect') renderConnect();
    else if (ui.tab === 'devices') renderDevices();
    else if (ui.tab === 'users') renderUsers();
    else if (ui.tab === 'keys') renderKeys();
    else if (ui.tab === 'settings') renderStats();
  }
  function setTab(tab) {
    ui.tab = tab;
    $$('.nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + tab); });
    $('#main').scrollTop = 0;
    renderCurrent();
    refreshCurrent(false);
  }
  async function refreshCurrent(force) {
    var btn = $('#refreshBtn'); btn.classList.add('spin');
    ui.lastRefresh = Date.now();
    try {
      if (ui.tab === 'devices') await loadNodes(force);
      else if (ui.tab === 'users') { await loadUsers(force); if (!ui.nodes && active() && active().apiKey) loadNodes(false).then(renderUsers); }
      else if (ui.tab === 'keys') await loadKeys(force);
      else if (ui.tab === 'connect') { var s = active(); if (s && force) { var r = await testServer(s); $('#quickMsg').className = 'hint ' + r.level; $('#quickMsg').textContent = r.text; renderConnect(); } }
    } finally { btn.classList.remove('spin'); renderStats(); }
  }
  var autoTimer = 0;
  function scheduleAuto() {
    clearInterval(autoTimer);
    var sec = Number(state.settings.refreshSec) || 0;
    if (!sec) return;
    autoTimer = setInterval(function () {
      if (document.visibilityState !== 'visible' || sheets.length) return;
      if (ui.tab === 'devices' || ui.tab === 'users' || ui.tab === 'keys') refreshCurrent(true);
    }, sec * 1000);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - ui.lastRefresh > 15000 && ui.tab !== 'settings') refreshCurrent(false);
  });

  /* ---------- events ---------- */
  var ACT = {
    'quick-connect': quickConnect,
    'quick': function (el) { runQuick(el.dataset.q); },
    'edit-quick': quickEditor,
    'add-server': function () { serverSheet(null); },
    'edit-server': function (el) { serverSheet(el.dataset.id); },
    'pick-server': function (el) { pickServer(el.dataset.id); },
    'open-servers': serverSwitcher,
    'refresh': function () { sched.invalidate(); refreshCurrent(true); },
    'copy-cmd': function (el) { copyText(cmdFor(el.dataset.which), '已复制命令'); },
    'copy-url': function () { var s = active(); if (s) copyText(s.url, '已复制地址'); },
    'toggle-dir': function () { state.settings.sortDir = state.settings.sortDir === 'asc' ? 'desc' : 'asc'; save(); renderDevices(); toast(state.settings.sortDir === 'asc' ? '升序' : '降序'); },
    'chip': function (el) {
      var k = el.dataset.k;
      if (k === 'all') { ui.onlineOnly = false; ui.user = ''; }
      else if (k === 'online') { ui.onlineOnly = !ui.onlineOnly; }
      else if (k === 'user') { ui.user = ui.user === el.dataset.u ? '' : el.dataset.u; }
      renderDevices();
    },
    'node': function (el) { nodeSheet(el.dataset.id); },
    'user': function (el) { userSheet(el.dataset.id); },
    'keyitem': function (el) { keyItemSheet(el.dataset.id); },
    'register-node': registerSheet,
    'new-user': newUserSheet,
    'new-key': function () { keySheet(); },
    'export': exportSheet,
    'import': importSheet,
    'reset-stats': function () { sched.resetStats(); renderStats(); },
    'close-sheet': function () { closeSheet(); },
    'wipe': async function () {
      if (!await confirmBox('清除全部数据', '将删除本机保存的所有服务器、API Key 与设置，且无法恢复。建议先导出备份。', '清除', true)) return;
      try { storage.removeItem('myscale.v1'); } catch (e) { /* ignore */ }
      state = C.defaultState(); store.save(state); sched.invalidate(); ui.nodes = ui.users = ui.keys = null; ui.health = {};
      applySettings(); renderChip(); renderCurrent(); toast('已清除');
    }
  };
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act],[data-tab]'); if (!t) return;
    if (t.dataset.tab && !t.dataset.act) { setTab(t.dataset.tab); return; }
    var fn = ACT[t.dataset.act]; if (!fn) return;
    // buttons nested in clickable cards must not trigger the card
    if (t.tagName === 'BUTTON' || e.target.closest('button') === t) e.stopPropagation();
    fn(t, e);
  });
  $('#scrim').addEventListener('click', function () { closeSheet(); });
  $('#q').addEventListener('input', function (e) { ui.q = e.target.value; renderDevices(); });
  $('#sortKey').addEventListener('change', function (e) { state.settings.sortKey = e.target.value; save(); renderDevices(); });
  $('#cmdKey').addEventListener('input', function () { $('#cmdLinux').textContent = cmdFor('linux'); });
  $('#quickUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') quickConnect(); });
  $('#quickKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') quickConnect(); });
  $$('[data-set]').forEach(function (g) {
    var key = g.dataset.set;
    if (key === 'accent') {
      g.innerHTML = Object.keys(ACCENTS).map(function (a) { return '<button data-v="' + a + '" aria-label="' + a + '" style="background:' + ACCENTS[a] + '"></button>'; }).join('');
    }
    g.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var v = b.dataset.v;
      if (key === 'refreshSec') v = Number(v);
      else if (key === 'maskKeys') v = v === 'true';
      state.settings[key] = v; save(); applySettings();
      if (key === 'maskKeys') renderKeys();
    });
  });

  /* ---------- boot ---------- */
  applySettings();
  renderChip();
  renderConnect();
  renderStats();
  if (active() && active().apiKey) setTab('devices');
  window.__myscale = { state: function () { return state; }, ui: ui, sched: sched, setTab: setTab, sheets: sheets };
})();
