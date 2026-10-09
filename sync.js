/* ARMAN CUT — offline-first sync with Supabase (REST only, no libraries).
   Phone storage is always the source of truth; this module only copies changes
   to/from Supabase whenever the network allows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArmanSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLS = ['id', 'name', 'phone', 'note', 'status', 'jy', 'jm', 'jd', 'hour', 'minute', 'deleted', 'client_ts'];
  var PAGE = 1000, CHUNK = 100;

  function sigOf(r) {
    return [r.name, r.phone, r.note, r.status, r.jy, r.jm, r.jd, r.hour, r.minute].join('\u0001');
  }
  function copyRec(r) {
    return { id: r.id, name: r.name || '', phone: r.phone || '', note: r.note || '', status: r.status || '',
      jy: r.jy, jm: r.jm, jd: r.jd, hour: r.hour, minute: r.minute, updatedAt: r.updatedAt || 0 };
  }
  function toRow(r, deleted, ts) {
    return { id: String(r.id), name: r.name || '', phone: r.phone || '', note: r.note || '', status: r.status || '',
      jy: r.jy | 0, jm: r.jm | 0, jd: r.jd | 0, hour: r.hour | 0, minute: r.minute | 0,
      deleted: !!deleted, client_ts: ts };
  }
  function fromRow(w) {
    return { id: String(w.id), name: w.name || '', phone: w.phone || '', note: w.note || '', status: w.status || '',
      jy: w.jy, jm: w.jm, jd: w.jd, hour: w.hour, minute: w.minute, updatedAt: Number(w.client_ts) || 0 };
  }
  function validRow(w) {
    return w && w.id != null && [w.jy, w.jm, w.jd, w.hour, w.minute].every(Number.isInteger);
  }
  function mkErr(msg, flags) { var e = new Error(msg); for (var k in flags) e[k] = flags[k]; return e; }
  function authErr() { return mkErr('auth', { auth: true }); }

  function create(opts) {
    opts = opts || {};
    var cfg = opts.config || {};
    var baseUrl = String(cfg.url || '').replace(/\/+$/, '');
    var apiKey = String(cfg.key || '');
    var configured = /^https?:\/\/\S+$/.test(baseUrl) && apiKey.length > 10;
    var storage = opts.storage;
    var doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    var now = opts.now || Date.now;
    var META_KEY = opts.metaKey || 'arman_cut_sync';
    var TIMEOUT = opts.timeoutMs || 12000;
    var DEBOUNCE = opts.debounceMs == null ? 1500 : opts.debounceMs;
    var isOnline = opts.isOnline || function () { return typeof navigator === 'undefined' || navigator.onLine !== false; };

    var meta = loadMeta();
    var snap = {};            // id -> { sig, rec } : what we last saw locally
    var status = 'unconfigured', message = '';
    var running = null, again = false, timer = null, intervalId = null;
    var failCount = 0, nextAllowed = 0, refreshing = null, started = false;

    /* ---------- meta ---------- */
    function loadMeta() {
      var m = null;
      try { m = JSON.parse(storage.getItem(META_KEY) || 'null'); } catch (e) {}
      if (!m || typeof m !== 'object') m = {};
      return { v: 1, session: m.session || null, userId: m.userId || null, email: m.email || '',
        pending: m.pending || {}, failed: m.failed || {}, lastPull: m.lastPull || null,
        lastSyncAt: m.lastSyncAt || 0, reauth: !!m.reauth };
    }
    function saveMeta() {
      try { storage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {}
    }
    function count(o) { return Object.keys(o).length; }

    /* ---------- state ---------- */
    function idleStatus() {
      if (!configured) return 'unconfigured';
      if (!meta.session) return meta.reauth ? 'reauth' : 'loggedout';
      if (count(meta.failed)) return 'error';
      if (count(meta.pending)) return 'pending';
      return 'synced';
    }
    function getState() {
      return { status: status, message: message, configured: configured, loggedIn: !!meta.session,
        email: meta.email, pendingCount: count(meta.pending), failedCount: count(meta.failed),
        lastSyncAt: meta.lastSyncAt, reauth: meta.reauth };
    }
    function setStatus(s, msg) {
      status = s; message = msg || '';
      if (opts.onStatus) { try { opts.onStatus(getState()); } catch (e) {} }
    }
    function setIdle() { setStatus(idleStatus(), idleStatus() === 'error' ? 'برخی نوبت‌ها همگام نشدند' : ''); }

    /* ---------- local change tracking ---------- */
    function nextTs(prev) { return Math.max(now(), (prev || 0) + 1); }

    function noteLocalChange() {
      var list = opts.getRecords() || [], seen = {}, dirty = false;
      for (var i = 0; i < list.length; i++) {
        var r = list[i]; if (!r || r.id == null) continue;
        var id = String(r.id); seen[id] = 1;
        var s = snap[id], sg = sigOf(r);
        if (!s || s.sig !== sg) {
          var ts = nextTs(Math.max(r.updatedAt || 0, s ? s.rec.updatedAt : 0, meta.pending[id] ? meta.pending[id].ts : 0));
          r.updatedAt = ts;
          meta.pending[id] = { op: 'upsert', ts: ts };
          delete meta.failed[id];
          snap[id] = { sig: sg, rec: copyRec(r) };
          dirty = true;
        }
      }
      Object.keys(snap).forEach(function (id) {
        if (seen[id]) return;
        var old = snap[id].rec;
        var ts = nextTs(Math.max(old.updatedAt || 0, meta.pending[id] ? meta.pending[id].ts : 0));
        meta.pending[id] = { op: 'delete', ts: ts, rec: old };
        delete meta.failed[id];
        delete snap[id];
        dirty = true;
      });
      if (dirty) {
        saveMeta();
        if (meta.session) { if (status === 'synced' || status === 'pending') setStatus('pending'); schedule(DEBOUNCE); }
        else if (opts.onStatus) setIdle();
      }
    }

    function rebuildSnapshot() {
      snap = {};
      (opts.getRecords() || []).forEach(function (r) {
        if (r && r.id != null) snap[String(r.id)] = { sig: sigOf(r), rec: copyRec(r) };
      });
    }

    // give every record a stamp and queue it for upload
    function markAllPending() {
      var list = opts.getRecords() || [];
      list.forEach(function (r) {
        var id = String(r.id);
        var ts = nextTs(Math.max(r.updatedAt || 0, meta.pending[id] ? meta.pending[id].ts : 0));
        r.updatedAt = ts;
        meta.pending[id] = { op: 'upsert', ts: ts };
      });
      rebuildSnapshot();
      saveMeta();
      if (opts.saveRecords) opts.saveRecords();
    }
    // records created before sync existed (no stamp)
    function adoptLegacy() {
      var list = opts.getRecords() || [], any = false;
      list.forEach(function (r) {
        if (!r.updatedAt) {
          var id = String(r.id);
          r.updatedAt = nextTs(0);
          meta.pending[id] = { op: 'upsert', ts: r.updatedAt };
          any = true;
        }
      });
      if (any) { rebuildSnapshot(); saveMeta(); if (opts.saveRecords) opts.saveRecords(); }
    }

    /* ---------- http ---------- */
    async function http(method, path, o) {
      o = o || {};
      var headers = { apikey: apiKey, Authorization: 'Bearer ' + (o.token || apiKey) };
      if (o.json !== undefined || o.body !== undefined) headers['Content-Type'] = 'application/json';
      if (o.headers) for (var k in o.headers) headers[k] = o.headers[k];
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT);
      var res;
      try {
        res = await doFetch(baseUrl + path, {
          method: method, headers: headers,
          body: o.json !== undefined ? JSON.stringify(o.json) : o.body,
          signal: ctrl ? ctrl.signal : undefined
        });
        var text = await res.text(), data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        return { status: res.status, ok: res.status >= 200 && res.status < 300, data: data, headers: res.headers };
      } catch (e) {
        throw mkErr('network', { network: true });
      } finally { clearTimeout(t); }
    }

    function setSession(d) {
      meta.session = { access_token: d.access_token, refresh_token: d.refresh_token,
        expiresAt: now() + (Number(d.expires_in) || 3600) * 1000 };
      if (d.user) { if (d.user.id) meta.userId = d.user.id; if (d.user.email) meta.email = d.user.email; }
      meta.reauth = false;
      saveMeta();
    }
    function dropSession() { meta.session = null; meta.reauth = true; saveMeta(); }

    function refresh() {
      if (refreshing) return refreshing;
      refreshing = (async function () {
        var s = meta.session;
        if (!s || !s.refresh_token) throw authErr();
        var res = await http('POST', '/auth/v1/token?grant_type=refresh_token', { json: { refresh_token: s.refresh_token } });
        if (res.ok && res.data && res.data.access_token) { setSession(res.data); return meta.session.access_token; }
        if (res.status >= 500 || res.status === 429) throw mkErr('server', { transient: true });
        dropSession(); throw authErr();
      })();
      var clear = function () { refreshing = null; };
      refreshing.then(clear, clear);
      return refreshing;
    }
    async function ensureToken() {
      if (!meta.session) throw authErr();
      if (meta.session.expiresAt - now() < 60000) return refresh();
      return meta.session.access_token;
    }
    async function rest(method, path, o) {
      o = o || {};
      for (var attempt = 0; attempt < 2; attempt++) {
        var token = attempt === 0 ? await ensureToken() : await refresh();
        var res = await http(method, path, { token: token, headers: o.headers, body: o.body });
        if (res.status === 401 && attempt === 0) continue;
        if (res.status === 401) { dropSession(); throw authErr(); }
        return res;
      }
    }

    /* ---------- auth API ---------- */
    async function signIn(email, password) {
      if (!configured) throw new Error('تنظیمات سرور (config.js) پر نشده است');
      var res;
      try { res = await http('POST', '/auth/v1/token?grant_type=password', { json: { email: String(email).trim(), password: password } }); }
      catch (e) { throw new Error('اتصال به سرور برقرار نشد. اینترنت/فیلترشکن را بررسی کنید'); }
      if (!res.ok || !res.data || !res.data.access_token) {
        if (res.status === 400 || res.status === 401 || res.status === 422) throw new Error('ایمیل یا رمز عبور اشتباه است');
        throw new Error('خطای سرور (' + res.status + ')');
      }
      var newId = res.data.user && res.data.user.id;
      var switched = meta.userId && newId && meta.userId !== newId;
      setSession(res.data);
      if (switched) { meta.pending = {}; meta.failed = {}; meta.lastPull = null; }
      if (switched || !meta.lastPull) { markAllPending(); } else { adoptLegacy(); }
      saveMeta();
      setIdle();
      failCount = 0; nextAllowed = 0;
      syncNow(true);
      return getState();
    }
    async function signOut() {
      var tok = meta.session && meta.session.access_token;
      meta.session = null; meta.reauth = false; saveMeta();
      setIdle();
      if (tok && configured) { try { await http('POST', '/auth/v1/logout', { token: tok }); } catch (e) {} }
    }

    /* ---------- push ---------- */
    function classify(res) {
      var code = res.data && res.data.code;
      if (res.status === 404 || res.status === 403 || code === '42501' || code === '42P01' || /^PGRST20[45]/.test(code || '')) {
        return mkErr('جدول یا دسترسی در Supabase درست تنظیم نشده (فایل supabase-schema.sql را اجرا کنید)', { fatal: true });
      }
      if (res.status >= 500 || res.status === 429 || res.status === 408) return mkErr('server ' + res.status, { transient: true });
      return null;
    }
    function clearSent(chunk) {
      chunk.forEach(function (c) {
        if (meta.pending[c.id] && meta.pending[c.id].ts === c.ts) delete meta.pending[c.id];
        if (meta.failed[c.id] && meta.failed[c.id].ts <= c.ts) delete meta.failed[c.id];
      });
      saveMeta();
    }
    async function pushChunk(chunk) {
      var res = await rest('POST', '/rest/v1/appointments?on_conflict=id&columns=' + COLS.join(','), {
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(chunk.map(function (c) { return c.row; }))
      });
      if (res.ok) { clearSent(chunk); return; }
      var e = classify(res); if (e) throw e;
      if (chunk.length > 1) { for (var i = 0; i < chunk.length; i++) await pushChunk([chunk[i]]); return; }
      var c = chunk[0], p = meta.pending[c.id];
      if (p && p.ts === c.ts) {
        meta.failed[c.id] = { op: p.op, ts: p.ts, rec: p.rec, msg: (res.data && res.data.message) || ('HTTP ' + res.status) };
        delete meta.pending[c.id];
        saveMeta();
      }
    }
    async function push() {
      var byId = {};
      (opts.getRecords() || []).forEach(function (r) { byId[String(r.id)] = r; });
      var items = [];
      Object.keys(meta.pending).forEach(function (id) {
        var p = meta.pending[id];
        var rec = p.op === 'delete' ? p.rec : byId[id];
        if (!rec) { delete meta.pending[id]; return; }
        items.push({ id: id, ts: p.ts, row: toRow(rec, p.op === 'delete', p.ts) });
      });
      saveMeta();
      for (var i = 0; i < items.length; i += CHUNK) await pushChunk(items.slice(i, i + CHUNK));
    }

    /* ---------- pull ---------- */
    function parseTotal(h) {
      try {
        var v = h && h.get && h.get('content-range');
        var m = v && /\/(\d+)$/.exec(v);
        return m ? parseInt(m[1], 10) : null;
      } catch (e) { return null; }
    }
    async function pull() {
      var filter = '';
      if (meta.lastPull) {
        var t = Date.parse(meta.lastPull);
        if (!isNaN(t)) filter = '&updated_at=gte.' + encodeURIComponent(new Date(t - 300000).toISOString());
      }
      var rows = [], offset = 0, maxUpd = meta.lastPull;
      for (;;) {
        var res = await rest('GET', '/rest/v1/appointments?select=*&order=updated_at.asc,id.asc&limit=' + PAGE + '&offset=' + offset + filter,
          { headers: { Prefer: 'count=exact' } });
        if (!res.ok) { var e = classify(res); throw e || mkErr('HTTP ' + res.status, { transient: true }); }
        var page = Array.isArray(res.data) ? res.data : [];
        rows = rows.concat(page);
        offset += page.length;
        var total = parseTotal(res.headers);
        if (!page.length) break;
        if (total != null ? offset >= total : page.length < PAGE) break;
      }
      rows.forEach(function (w) {
        if (w.updated_at && (!maxUpd || Date.parse(w.updated_at) > Date.parse(maxUpd))) maxUpd = w.updated_at;
      });
      applyRows(rows);          // synchronous: no local edit can slip in between
      if (maxUpd) meta.lastPull = maxUpd;
      saveMeta();
    }
    function applyRows(rows) {
      var list = (opts.getRecords() || []).slice();
      var idx = {}; list.forEach(function (r, i) { idx[String(r.id)] = i; });
      var remove = {}, changed = false;
      rows.forEach(function (w) {
        if (!validRow(w)) return;
        var id = String(w.id), ts = Number(w.client_ts) || 0;
        var p = meta.pending[id], f = meta.failed[id];
        if (p && p.ts >= ts) return;
        if (f && f.ts >= ts) return;
        var li = idx[id], local = li == null ? null : list[li];
        if (local && !p && (local.updatedAt || 0) >= ts) return;
        delete meta.pending[id]; delete meta.failed[id];
        if (w.deleted) {
          if (local) { remove[id] = 1; delete snap[id]; changed = true; }
        } else {
          var rec = fromRow(w);
          if (local) list[li] = rec; else { list.push(rec); idx[id] = list.length - 1; }
          delete remove[id];
          snap[id] = { sig: sigOf(rec), rec: copyRec(rec) };
          changed = true;
        }
      });
      if (changed) {
        opts.setRecords(list.filter(function (r) { return !remove[String(r.id)]; }));
        if (opts.onChange) { try { opts.onChange(); } catch (e) {} }
      }
    }

    /* ---------- orchestration ---------- */
    function requeueFailed() {
      Object.keys(meta.failed).forEach(function (id) {
        var f = meta.failed[id];
        if (!meta.pending[id]) meta.pending[id] = { op: f.op, ts: f.ts, rec: f.rec };
        delete meta.failed[id];
      });
      saveMeta();
    }

    function syncNow(manual) {
      if (!configured || !meta.session) return Promise.resolve();
      if (running) { again = true; return running; }
      if (!manual && now() < nextAllowed) return Promise.resolve();
      if (!isOnline() && !manual) { setStatus('offline'); return Promise.resolve(); }
      if (manual) requeueFailed();
      running = (async function () {
        try {
          setStatus('syncing');
          noteLocalChange();
          await push();
          await pull();
          meta.lastSyncAt = now(); saveMeta();
          failCount = 0; nextAllowed = 0;
          setIdle();
        } catch (e) {
          if (e.auth) { setStatus('reauth', 'نشست منقضی شد؛ دوباره وارد شوید'); }
          else if (e.fatal) { failCount++; nextAllowed = now() + 300000; setStatus('error', e.message); }
          else {
            failCount++;
            nextAllowed = now() + Math.min(300000, 30000 * Math.pow(2, failCount - 1));
            if (e.network) setStatus('offline');
            else setStatus('error', 'خطای سرور؛ بعداً دوباره تلاش می‌شود');
          }
        } finally {
          running = null;
          if (again) { again = false; schedule(100); }
        }
      })();
      return running;
    }

    function schedule(delay) {
      if (!configured || !meta.session) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; syncNow(false); }, delay);
      if (timer && timer.unref && opts.unref) timer.unref();
    }

    function start() {
      if (started) return; started = true;
      rebuildSnapshot();
      // drop stale pending upserts whose record vanished
      Object.keys(meta.pending).forEach(function (id) {
        var p = meta.pending[id];
        if (p.op === 'upsert' && !snap[id]) delete meta.pending[id];
      });
      if (meta.session) adoptLegacy();
      saveMeta();
      setIdle();
      if (meta.session) schedule(300);
      if (opts.autoEvents !== false && typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', function () { failCount = 0; nextAllowed = 0; schedule(500); });
        document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(500); });
        intervalId = setInterval(function () { if (meta.session) syncNow(false); }, 60000);
      }
    }

    return { start: start, signIn: signIn, signOut: signOut, syncNow: function () { return syncNow(true); },
      noteLocalChange: noteLocalChange, getState: getState, isConfigured: function () { return configured; },
      _meta: function () { return meta; } };
  }

  return { create: create };
});
