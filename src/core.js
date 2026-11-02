/* MyScale core: pure logic (no DOM). Works in browser (window.MyScaleCore) and Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MyScaleCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- server address ---------- */

  var PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|.*\.local$|.*\.lan$|.*\.internal$)/i;

  // Accepts: "hs.example.com", "https://hs.example.com/", "192.168.1.5:8080", "http://x:8080/api/v1", etc.
  function normalizeServerUrl(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return { ok: false, error: '地址为空' };
    if (/\s/.test(s)) return { ok: false, error: '地址不能包含空格' };
    var hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
    if (hasScheme && !/^https?:\/\//i.test(s)) return { ok: false, error: '仅支持 http / https' };
    if (!hasScheme) {
      var host = s.replace(/[\/?#].*$/, '').replace(/:\d+$/, '');
      s = (PRIVATE_HOST.test(host) ? 'http://' : 'https://') + s;
    }
    var u;
    try { u = new URL(s); } catch (e) { return { ok: false, error: '地址格式不正确' }; }
    if (!u.hostname) return { ok: false, error: '缺少主机名' };
    var path = u.pathname.replace(/\/+$/, '');
    // strip well-known API suffixes users tend to paste
    path = path.replace(/\/(api\/v1(\/.*)?|health|swagger|key|machine\/register|windows)$/i, '');
    path = path.replace(/\/+$/, '');
    var url = u.protocol + '//' + u.host + path;
    return { ok: true, url: url, scheme: u.protocol.replace(':', ''), host: u.hostname, port: u.port || '' };
  }

  function sameServer(a, b) {
    var x = normalizeServerUrl(a), y = normalizeServerUrl(b);
    return x.ok && y.ok && x.url.toLowerCase() === y.url.toLowerCase();
  }

  function apiUrl(base, path) {
    return String(base).replace(/\/+$/, '') + '/api/v1' + (path.charAt(0) === '/' ? path : '/' + path);
  }

  function buildLoginCommands(serverUrl, preAuthKey) {
    var cmds = {
      linux: 'sudo tailscale up --login-server ' + serverUrl + (preAuthKey ? ' --authkey ' + preAuthKey : ''),
      reset: 'sudo tailscale up --reset --login-server ' + serverUrl + (preAuthKey ? ' --authkey ' + preAuthKey : ''),
      register: 'headscale nodes register --user <USER> --key <NODEKEY>'
    };
    return cmds;
  }

  // `tailscale up --login-server X` prints a URL like https://X/register/<AUTHID>; accept URL or bare id.
  function extractAuthId(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s || /\s/.test(s)) return '';
    s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
    var i = s.lastIndexOf('/');
    if (i !== -1) s = s.slice(i + 1);
    return /^[A-Za-z0-9._:-]{6,}$/.test(s) ? s : '';
  }

  /* ---------- parsing (tolerant: Headscale JSON is camelCase via grpc-gateway; also accept snake_case) ---------- */

  function pick(o, names, dflt) {
    for (var i = 0; i < names.length; i++) {
      if (o && o[names[i]] !== undefined && o[names[i]] !== null) return o[names[i]];
    }
    return dflt;
  }

  // protobuf Timestamp may arrive as RFC3339 string; epoch-zero / year-1 means "never".
  function parseTime(v) {
    if (v == null || v === '') return null;
    var d;
    if (typeof v === 'object' && v.seconds != null) d = new Date(Number(v.seconds) * 1000);
    else d = new Date(v);
    var t = d.getTime();
    if (isNaN(t) || t <= 0 || d.getUTCFullYear() < 1971) return null;
    return t;
  }

  function parseNode(n) {
    var user = pick(n, ['user'], null);
    var ips = pick(n, ['ipAddresses', 'ip_addresses'], []);
    var name = pick(n, ['givenName', 'given_name'], '') || pick(n, ['name'], '') || ('node-' + pick(n, ['id'], '?'));
    var tags = [].concat(pick(n, ['forcedTags', 'forced_tags'], []), pick(n, ['validTags', 'valid_tags'], []));
    var seen = {};
    tags = tags.filter(function (t) { if (seen[t]) return false; seen[t] = 1; return true; });
    return {
      id: String(pick(n, ['id'], '')),
      name: String(name),
      hostname: String(pick(n, ['name'], '')),
      user: user && typeof user === 'object' ? String(pick(user, ['name'], '')) : (user ? String(user) : ''),
      ips: Array.isArray(ips) ? ips.map(String) : [],
      online: pick(n, ['online'], false) === true,
      lastSeen: parseTime(pick(n, ['lastSeen', 'last_seen'], null)),
      expiry: parseTime(pick(n, ['expiry'], null)),
      createdAt: parseTime(pick(n, ['createdAt', 'created_at'], null)),
      tags: tags,
      method: String(pick(n, ['registerMethod', 'register_method'], ''))
    };
  }

  function parseNodes(json) {
    var arr = json && (json.nodes || json.machines);
    return Array.isArray(arr) ? arr.map(parseNode) : [];
  }

  function parseUsers(json) {
    var arr = json && json.users;
    if (!Array.isArray(arr)) return [];
    return arr.map(function (u) {
      return {
        id: String(pick(u, ['id'], '')),
        name: String(pick(u, ['name'], '')),
        displayName: String(pick(u, ['displayName', 'display_name'], '')),
        email: String(pick(u, ['email'], '')),
        createdAt: parseTime(pick(u, ['createdAt', 'created_at'], null))
      };
    });
  }

  function parsePreAuthKeys(json) {
    var arr = json && (json.preAuthKeys || json.pre_auth_keys);
    if (!Array.isArray(arr)) return [];
    return arr.map(function (k) {
      var user = pick(k, ['user'], null);
      return {
        id: String(pick(k, ['id'], '')),
        key: String(pick(k, ['key'], '')),
        user: user && typeof user === 'object' ? String(pick(user, ['name'], '')) : (user ? String(user) : ''),
        reusable: pick(k, ['reusable'], false) === true,
        ephemeral: pick(k, ['ephemeral'], false) === true,
        used: pick(k, ['used'], false) === true,
        expiration: parseTime(pick(k, ['expiration'], null)),
        tags: pick(k, ['aclTags', 'acl_tags'], [])
      };
    });
  }

  function parseCreatedKey(json) {
    var k = json && (json.preAuthKey || json.pre_auth_key);
    return k && k.key ? String(k.key) : '';
  }

  /* ---------- sorting / filtering ---------- */

  function ipSortKey(ip) {
    var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip || '');
    if (!m) return Infinity;
    return ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
  }

  function sortNodes(nodes, key, dir) {
    var mul = dir === 'desc' ? -1 : 1;
    var cmp = {
      name: function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); },
      ip: function (a, b) { return ipSortKey(a.ips[0]) - ipSortKey(b.ips[0]); },
      lastSeen: function (a, b) { return (a.lastSeen || 0) - (b.lastSeen || 0); },
      user: function (a, b) { return a.user.localeCompare(b.user) || a.name.localeCompare(b.name); },
      online: function (a, b) { return (a.online ? 1 : 0) - (b.online ? 1 : 0) || a.name.localeCompare(b.name); }
    }[key] || function () { return 0; };
    return nodes.slice().sort(function (a, b) {
      var r = cmp(a, b);
      if (r === 0 || r !== r) r = a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);
      return r * mul;
    });
  }

  function filterNodes(nodes, query, opts) {
    opts = opts || {};
    var q = String(query || '').trim().toLowerCase();
    return nodes.filter(function (n) {
      if (opts.onlineOnly && !n.online) return false;
      if (opts.user && n.user !== opts.user) return false;
      if (!q) return true;
      var hay = [n.name, n.hostname, n.user, n.ips.join(' '), n.tags.join(' ')].join(' ').toLowerCase();
      return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
    });
  }

  function summarize(nodes) {
    var online = 0, expired = 0, now = Date.now(), users = {};
    nodes.forEach(function (n) {
      if (n.online) online++;
      if (n.expiry && n.expiry < now) expired++;
      if (n.user) users[n.user] = 1;
    });
    return { total: nodes.length, online: online, offline: nodes.length - online, expired: expired, users: Object.keys(users).length };
  }

  /* ---------- time formatting ---------- */

  function relTime(ts, now) {
    if (!ts) return '从未';
    now = now == null ? Date.now() : now;
    var s = Math.round((now - ts) / 1000);
    var future = s < 0; s = Math.abs(s);
    var v, u;
    if (s < 45) return future ? '即将' : '刚刚';
    if (s < 3600) { v = Math.round(s / 60); u = '分钟'; }
    else if (s < 86400) { v = Math.round(s / 3600); u = '小时'; }
    else if (s < 86400 * 60) { v = Math.round(s / 86400); u = '天'; }
    else { v = Math.round(s / (86400 * 30)); u = '个月'; }
    return future ? v + u + '后' : v + u + '前';
  }

  function toIsoDuration(hours) {
    var h = Math.max(1, Math.floor(Number(hours) || 1));
    return new Date(Date.now() + h * 3600 * 1000).toISOString();
  }

  /* ---------- request scheduler: serial + min interval + coalesce + TTL cache ---------- */

  function createScheduler(opts) {
    opts = opts || {};
    var minInterval = opts.minInterval != null ? opts.minInterval : 350;
    var ttl = opts.ttl != null ? opts.ttl : 15000;
    var now = opts.now || function () { return Date.now(); };
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var cache = {};           // key -> {t, v}
    var inflight = {};        // key -> Promise
    var chain = Promise.resolve();
    var lastStart = -Infinity;
    var stats = { calls: 0, network: 0, cacheHits: 0, coalesced: 0, errors: 0 };

    function run(key, task, o) {
      o = o || {};
      stats.calls++;
      var c = cache[key];
      if (!o.force && c && now() - c.t < (o.ttl != null ? o.ttl : ttl)) { stats.cacheHits++; return Promise.resolve(c.v); }
      if (inflight[key]) { stats.coalesced++; return inflight[key]; }
      var p = new Promise(function (resolve, reject) {
        chain = chain.then(function () {
          var wait = lastStart + minInterval - now();
          return wait > 0 ? sleep(wait) : null;
        }).then(function () {
          lastStart = now();
          stats.network++;
          return task();
        }).then(function (v) {
          cache[key] = { t: now(), v: v };
          delete inflight[key];
          resolve(v);
        }, function (err) {
          stats.errors++;
          delete inflight[key];
          reject(err);
        });
      });
      inflight[key] = p;
      return p;
    }
    function invalidate(prefix) {
      Object.keys(cache).forEach(function (k) { if (!prefix || k.indexOf(prefix) === 0) delete cache[k]; });
    }
    return { run: run, invalidate: invalidate, stats: function () { return Object.assign({}, stats); }, resetStats: function () { stats = { calls: 0, network: 0, cacheHits: 0, coalesced: 0, errors: 0 }; } };
  }


  /* ---------- quick actions & user-defined buttons ---------- */

  var MAX_BUTTONS = 24;
  var METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  var QUICK_BUILTINS = [
    { id: 'health', label: '检测连接', icon: 'bolt' },
    { id: 'cmd', label: '复制登录命令', icon: 'copy' },
    { id: 'url', label: '复制地址', icon: 'link' },
    { id: 'newkey', label: '生成密钥', icon: 'key' },
    { id: 'newuser', label: '新建用户', icon: 'users' },
    { id: 'register', label: '注册设备', icon: 'plus' },
    { id: 'servers', label: '切换服务器', icon: 'globe' },
    { id: 'refresh', label: '强制刷新', icon: 'refresh' },
    { id: 'export', label: '导出备份', icon: 'download' }
  ];
  var DEFAULT_QUICK = ['health', 'cmd', 'newkey', 'newuser', 'register', 'servers'];
  var BUTTON_PRESETS = [
    { label: '节点列表', kind: 'api', method: 'GET', path: '/api/v1/node' },
    { label: '用户列表', kind: 'api', method: 'GET', path: '/api/v1/user' },
    { label: 'API Key 列表', kind: 'api', method: 'GET', path: '/api/v1/apikey' },
    { label: '读取 ACL 策略', kind: 'api', method: 'GET', path: '/api/v1/policy' },
    { label: '健康检查', kind: 'api', method: 'GET', path: '/health' },
    { label: '复制 up 命令', kind: 'copy', template: 'tailscale up --login-server={url} --reset' },
    { label: '复制服务器信息', kind: 'copy', template: 'login-server: {url}\nhost: {host}\ntime: {now}' }
  ];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  /* {url} {host} {key} {name} {now} {date} {in1d} {in7d} {in30d}; unknown {tokens} are left as they are */
  function fillTemplate(str, ctx) {
    ctx = ctx || {};
    var now = ctx.now instanceof Date ? ctx.now : new Date();
    function plus(days) { return new Date(now.getTime() + days * 86400000).toISOString(); }
    var map = {
      url: ctx.url || '', host: ctx.host || '', key: ctx.key || '', name: ctx.name || '',
      now: now.toISOString(), date: now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()),
      in1d: plus(1), in7d: plus(7), in30d: plus(30)
    };
    return String(str == null ? '' : str).replace(/\{(url|host|key|name|now|date|in1d|in7d|in30d)\}/g, function (m, k) { return map[k]; });
  }

  function normalizeButtonPath(p) {
    p = String(p == null ? '' : p).trim();
    if (!p) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return '';            // no scheme/host: always the active server
    if (p.charAt(0) !== '/') p = '/' + p;
    if (p.indexOf('//') === 0 || /\s/.test(p) || p.indexOf('..') >= 0 || p.length > 300) return '';
    if (!/^[\w\-./~%:?&=,+@]+$/.test(p)) return '';
    return p;
  }
  function validBodyJson(text) {
    try { JSON.parse(String(text).replace(/\{[a-z0-9]+\}/gi, '0')); return true; } catch (e) { return false; }
  }
  function randId() { return 'b' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

  /* returns { ok, button } or { ok:false, error } */
  function validateButton(b) {
    if (!b || typeof b !== 'object') return { ok: false, error: '无效的按钮' };
    var label = String(b.label == null ? '' : b.label).trim().slice(0, 20);
    if (!label) return { ok: false, error: '请填写按钮名称' };
    var id = String(b.id || '').replace(/[^\w-]/g, '').slice(0, 24) || randId();
    var out = { id: id, label: label, kind: b.kind === 'copy' ? 'copy' : 'api', confirm: b.confirm === true };
    if (out.kind === 'copy') {
      out.template = String(b.template == null ? '' : b.template).slice(0, 2000);
      if (!out.template.trim()) return { ok: false, error: '请填写要复制的文本' };
      return { ok: true, button: out };
    }
    var method = String(b.method || 'GET').toUpperCase();
    if (METHODS.indexOf(method) < 0) return { ok: false, error: '不支持的请求方法：' + method };
    var path = normalizeButtonPath(b.path);
    if (!path) return { ok: false, error: '接口路径无效：只写服务器后面的路径，例如 /api/v1/node（不要带域名）' };
    out.method = method; out.path = path;
    var body = method === 'GET' ? '' : String(b.body == null ? '' : b.body).slice(0, 5000);
    if (body.trim() && !validBodyJson(body)) return { ok: false, error: '请求体不是有效的 JSON' };
    out.body = body.trim() ? body : '';
    if (method !== 'GET') out.confirm = true;                 // anything that writes always asks first
    return { ok: true, button: out };
  }
  function sanitizeButton(b) { var r = validateButton(b); return r.ok ? r.button : null; }
  function sanitizeButtons(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (b) {
      if (out.length >= MAX_BUTTONS) return;
      var x = sanitizeButton(b); if (!x) return;
      while (seen[x.id]) x.id = x.id + 'x';
      seen[x.id] = 1; out.push(x);
    });
    return out;
  }
  function buttonSignature(b) { return [b.kind, b.label, b.method || '', b.path || '', b.template || ''].join('\u0001'); }

  /* quick = ordered list of tokens: a built-in id, or "c:<custom button id>" */
  function sanitizeQuick(list, buttons) {
    var known = {};
    QUICK_BUILTINS.forEach(function (x) { known[x.id] = 1; });
    (buttons || []).forEach(function (b) { known['c:' + b.id] = 1; });
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (t) {
      t = String(t);
      if (known[t] && !seen[t]) { seen[t] = 1; out.push(t); }
    });
    return out;
  }
  function moveItem(arr, i, dir) {
    var out = arr.slice(), j = i + dir;
    if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
    var t = out[i]; out[i] = out[j]; out[j] = t; return out;
  }

  /* ---------- storage (every access wrapped in try/catch) ---------- */

  var KEY = 'myscale.v1';

  function defaultState() {
    return { version: 1, servers: [], activeId: '', buttons: [], quick: DEFAULT_QUICK.slice(), settings: { theme: 'dark', accent: 'indigo', density: 'comfortable', refreshSec: 0, sortKey: 'online', sortDir: 'desc', maskKeys: true, bg: 'aurora' } };
  }

  function createStore(storage, key) {
    key = key || KEY;
    var mem = null; // fallback when storage unusable
    function load() {
      try {
        var raw = storage.getItem(key);
        if (!raw) return mem || defaultState();
        return sanitizeState(JSON.parse(raw));
      } catch (e) { return mem || defaultState(); }
    }
    function save(state) {
      mem = state;
      try { storage.setItem(key, JSON.stringify(state)); return true; } catch (e) { return false; }
    }
    return { load: load, save: save };
  }

  function sanitizeState(s) {
    var d = defaultState();
    if (!s || typeof s !== 'object') return d;
    var servers = Array.isArray(s.servers) ? s.servers : [];
    var seen = {};
    d.servers = servers.map(function (x) {
      if (!x || typeof x !== 'object') return null;
      var n = normalizeServerUrl(x.url);
      if (!n.ok) return null;
      var id = String(x.id || '') || ('s' + Math.random().toString(36).slice(2, 10));
      if (seen[id]) id = id + Math.random().toString(36).slice(2, 5);
      seen[id] = 1;
      return { id: id, name: String(x.name || n.host), url: n.url, apiKey: String(x.apiKey || ''), note: String(x.note || ''), createdAt: Number(x.createdAt) || Date.now(), lastOk: Number(x.lastOk) || 0, color: String(x.color || ''), insecure: x.insecure === true };
    }).filter(Boolean);
    d.activeId = d.servers.some(function (x) { return x.id === s.activeId; }) ? s.activeId : (d.servers[0] ? d.servers[0].id : '');
    d.settings = Object.assign(d.settings, s.settings && typeof s.settings === 'object' ? s.settings : {});
    d.buttons = sanitizeButtons(s.buttons);
    d.quick = Array.isArray(s.quick) ? sanitizeQuick(s.quick, d.buttons) : DEFAULT_QUICK.slice();
    return d;
  }

  function exportBackup(state, opts) {
    opts = opts || {};
    var copy = JSON.parse(JSON.stringify(state));
    if (opts.stripKeys) copy.servers.forEach(function (s) { s.apiKey = ''; });
    return JSON.stringify({ app: 'MyScale', format: 1, exportedAt: new Date().toISOString(), keysIncluded: !opts.stripKeys, state: copy }, null, 2);
  }

  function importBackup(text, current, mode) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: '不是有效的 JSON' }; }
    if (!obj || obj.app !== 'MyScale' || !obj.state) return { ok: false, error: '不是 MyScale 备份文件' };
    var incoming = sanitizeState(obj.state);
    if (mode === 'replace') return { ok: true, state: incoming, added: incoming.servers.length, skipped: 0 };
    var out = sanitizeState(current);
    var added = 0, skipped = 0;
    incoming.servers.forEach(function (s) {
      var dup = out.servers.some(function (x) { return sameServer(x.url, s.url); });
      if (dup) { skipped++; return; }
      if (out.servers.some(function (x) { return x.id === s.id; })) s.id = s.id + 'i';
      out.servers.push(s); added++;
    });
    if (!out.activeId && out.servers[0]) out.activeId = out.servers[0].id;
    var buttonsAdded = 0;
    incoming.buttons.forEach(function (b) {
      var sig = buttonSignature(b);
      if (out.buttons.some(function (x) { return buttonSignature(x) === sig; })) return;
      if (out.buttons.length >= MAX_BUTTONS) return;
      while (out.buttons.some(function (x) { return x.id === b.id; })) b.id = b.id + 'i';
      out.buttons.push(b); out.quick.push('c:' + b.id); buttonsAdded++;
    });
    return { ok: true, state: out, added: added, skipped: skipped, buttonsAdded: buttonsAdded };
  }

  /* ---------- API errors ---------- */

  function describeHttpError(status, body) {
    if (status === 401 || status === 403) return '认证失败（' + status + '）：API Key 无效或已过期。可在服务器上执行 headscale apikeys create 重新生成。';
    if (status === 404) return '接口不存在（404）：请确认地址正确、版本支持 REST API，且反向代理未拦截 /api。';
    if (status === 429) return '请求过于频繁（429），请稍后再试。';
    if (status >= 500) return '服务器内部错误（' + status + '）。';
    var extra = '';
    try { var j = typeof body === 'string' ? JSON.parse(body) : body; if (j && j.message) extra = '：' + j.message; } catch (e) { /* ignore */ }
    return '请求失败（' + status + '）' + extra;
  }

  function maskKey(k) {
    k = String(k || '');
    if (k.length <= 8) return k ? '••••' : '';
    return k.slice(0, 4) + '••••' + k.slice(-3);
  }

  return {
    normalizeServerUrl: normalizeServerUrl, sameServer: sameServer, extractAuthId: extractAuthId, apiUrl: apiUrl, buildLoginCommands: buildLoginCommands,
    parseNodes: parseNodes, parseUsers: parseUsers, parsePreAuthKeys: parsePreAuthKeys, parseCreatedKey: parseCreatedKey, parseTime: parseTime,
    sortNodes: sortNodes, filterNodes: filterNodes, summarize: summarize, relTime: relTime, toIsoDuration: toIsoDuration,
    createScheduler: createScheduler, createStore: createStore, defaultState: defaultState, sanitizeState: sanitizeState,
    exportBackup: exportBackup, importBackup: importBackup, describeHttpError: describeHttpError, maskKey: maskKey,
    fillTemplate: fillTemplate, validateButton: validateButton, sanitizeButton: sanitizeButton, sanitizeButtons: sanitizeButtons,
    sanitizeQuick: sanitizeQuick, moveItem: moveItem, normalizeButtonPath: normalizeButtonPath,
    QUICK_BUILTINS: QUICK_BUILTINS, DEFAULT_QUICK: DEFAULT_QUICK, BUTTON_PRESETS: BUTTON_PRESETS, METHODS: METHODS, MAX_BUTTONS: MAX_BUTTONS
  };
});
