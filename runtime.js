/* Kumbara bağımsız (önizleme) çalışma zamanı.
   Artifact ortamındaki window.claude.use('db' | 'user' | 'downloads') yeteneklerini
   tarayıcıda yerel olarak taklit eder. Veriler localStorage'da kalır; gerçek veriyle bağlantı YOK. */
(function () {
  'use strict';
  var KEY = 'kumbara-app:v1';
  var BAND_KEY = 'kumbara-app:bant-kapali'; // sessionStorage: bant bu oturumda kapatıldı
  var store = {};          // { koleksiyon: { id: belge } }
  var listeners = [];      // { c, id|null, fn }
  var seq = 0;

  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function err(msg, code) { var e = new Error(msg); e.code = code; return e; }

  /* ---------- Kalıcılık ---------- */
  function persist() { localStorage.setItem(KEY, JSON.stringify({ v: 1, data: store })); }
  function loadStore() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* depo kapalı */ }
    if (raw) {
      try { var o = JSON.parse(raw); if (o && o.v === 1 && o.data) { store = o.data; return; } } catch (e) { console.warn('Kumbara önizleme: kayıtlı veri okunamadı, örnek veri yüklenecek.'); }
    }
    seedSamples(false);
  }
  function seedSamples(thenPersist) {
    store = (window.KUMBARA_ORNEK ? window.KUMBARA_ORNEK(new Date()) : {});
    try { persist(); } catch (e) { if (thenPersist) throw e; console.warn('Kumbara önizleme: veri kaydedilemedi', e); }
  }

  /* ---------- Yazma: önce belleğe, sonra depoya; depo reddederse geri al ve reddet ---------- */
  function commit(c, id, next) {
    var had = store[c] && Object.prototype.hasOwnProperty.call(store[c], id), prev = had ? store[c][id] : undefined;
    var createdColl = !store[c];
    if (!store[c]) store[c] = {};
    if (next === undefined) delete store[c][id]; else store[c][id] = next;
    try { persist(); }
    catch (e) {
      if (had) store[c][id] = prev; else delete store[c][id];
      if (createdColl && !Object.keys(store[c]).length) delete store[c];
      var q = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
      throw err(q ? 'Telefonun tarayıcı deposu dolu; kayıt yapılamadı.' : 'Kayıt yapılamadı: ' + (e && e.message), q ? 'resource-exhausted' : 'unavailable');
    }
    notify(c, id);
  }

  /* ---------- Dinleyiciler ---------- */
  function notify(c, id) {
    listeners.slice().forEach(function (l) {
      if (l.c !== c || (l.id !== null && l.id !== id)) return;
      if (l.queued) return; l.queued = true;
      setTimeout(function () { l.queued = false; if (listeners.indexOf(l) >= 0) l.fn(); }, 0);
    });
  }
  function addListener(c, id, fn) {
    var l = { c: c, id: id, fn: fn, queued: false };
    listeners.push(l); l.queued = true;
    setTimeout(function () { l.queued = false; if (listeners.indexOf(l) >= 0) fn(); }, 0);
    return function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  }

  /* ---------- Belge / sorgu ---------- */
  function snapDoc(id, d) { return { id: id, exists: d !== undefined, data: function () { return clone(d); } }; }
  function getPath(o, f) { return String(f).split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o); }
  var OPS = {
    '>=': function (a, b) { return a >= b; }, '<': function (a, b) { return a < b; }, '==': function (a, b) { return a === b; },
    '>': function (a, b) { return a > b; }, '<=': function (a, b) { return a <= b; }, '!=': function (a, b) { return a !== b; },
    'in': function (a, b) { return Array.isArray(b) && b.indexOf(a) >= 0; }
  };
  function splitPath(p) { var i = String(p).indexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; }

  function docRef(path) {
    var pp = splitPath(path), c = pp[0], id = pp[1];
    var ref = {
      id: id, path: path,
      get: function () { return Promise.resolve(snapDoc(id, store[c] && store[c][id])); },
      set: function (d) { return run(function () { commit(c, id, clone(d)); }); },
      update: function (d) {
        return run(function () {
          var cur = store[c] && store[c][id];
          if (cur === undefined) throw err('Belge yok: ' + path, 'not-found');
          var next = Object.assign({}, cur), p = clone(d) || {};
          Object.keys(p).forEach(function (k) {
            if (p[k] && typeof p[k] === 'object' && p[k].__delete__ === true) delete next[k]; else next[k] = p[k];
          });
          commit(c, id, next);
        });
      },
      delete: function () { return run(function () { commit(c, id, undefined); }); },
      onSnapshot: function (cb, ecb) { return addListener(c, id, function () { try { cb(snapDoc(id, store[c] && clone(store[c][id]))); } catch (e) { console.error(e); } }); }
    };
    return ref;
  }
  function run(fn) { return new Promise(function (res, rej) { try { fn(); res(); } catch (e) { rej(e); } }); }

  function query(c, filters, lim, order) {
    var q = {
      where: function (f, o, v) { if (!OPS[o]) throw err('Desteklenmeyen işleç: ' + o, 'invalid-argument'); return query(c, filters.concat([[f, o, v]]), lim, order); },
      limit: function (l) { return query(c, filters, l, order); },
      orderBy: function (f, dir) { return query(c, filters, lim, order.concat([[f, dir === 'desc' ? -1 : 1]])); },
      _run: function () {
        var coll = store[c] || {}, ids = Object.keys(coll).filter(function (id) {
          return filters.every(function (x) { var val = getPath(coll[id], x[0]); if (val === undefined && x[1] !== '!=') return false; return OPS[x[1]](val, x[2]); });
        });
        if (order.length) ids.sort(function (a, b) {
          for (var i = 0; i < order.length; i++) { var f = order[i][0], d = order[i][1], x = getPath(coll[a], f), y = getPath(coll[b], f); if (x < y) return -d; if (x > y) return d; }
          return 0;
        });
        if (lim != null) ids = ids.slice(0, lim);
        var docs = ids.map(function (id) { return snapDoc(id, coll[id]); });
        return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); } };
      },
      get: function () { return Promise.resolve(q._run()); },
      onSnapshot: function (cb, ecb) { return addListener(c, null, function () { try { cb(q._run()); } catch (e) { console.error(e); } }); },
      doc: function (id) { return docRef(c + '/' + (id || newId())); },
      add: function (d) { var id = newId(); return run(function () { commit(c, id, clone(d)); }).then(function () { return docRef(c + '/' + id); }); }
    };
    return q;
  }
  function newId() { return 'a' + Date.now().toString(36) + (++seq).toString(36) + Math.random().toString(36).slice(2, 7); }

  var db = { collection: function (c) { return query(c, [], null, []); }, doc: docRef };

  /* ---------- Kullanıcı ve indirme ---------- */
  var ME = { id: 'yerel', name: 'Yerel kullanıcı' };
  var user = {
    isOwner: function () { return Promise.resolve(true); },
    canEdit: function () { return Promise.resolve(true); },
    can: function () { return Promise.resolve(true); },
    id: function () { return Promise.resolve(ME.id); },
    me: function () { return Promise.resolve(Object.assign({}, ME)); },
    profiles: function () { return Promise.resolve([Object.assign({}, ME)]); }
  };
  var downloads = {
    save: function (o) {
      return new Promise(function (res, rej) {
        try {
          var data = o && o.data, blob = data instanceof Blob ? data : new Blob([data], { type: (o && o.type) || 'application/json' });
          var url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = (o && o.filename) || 'kumbara.json'; a.style.display = 'none';
          document.body.appendChild(a); a.click();
          setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
          res();
        } catch (e) { rej(e); }
      });
    }
  };

  window.claude = { use: function (name) { return Promise.resolve(({ db: db, user: user, downloads: downloads })[name] || null); } };
  window.kumbaraOrnekleriYenidenYukle = function () { seedSamples(true); };

  loadStore();

  /* ---------- Önizleme bandı ---------- */
  function mountBand() {
    try { if (sessionStorage.getItem(BAND_KEY)) return; } catch (e) { /* yoksay */ }
    var st = document.createElement('style');
    st.textContent =
      '#kb-band{box-sizing:border-box;position:relative;z-index:30;display:flex;align-items:center;gap:8px;min-height:26px;' +
      'padding:calc(3px + env(safe-area-inset-top,0px)) max(10px,env(safe-area-inset-right,0px)) 3px max(10px,env(safe-area-inset-left,0px));' +
      'background:#F0B44C;color:#1A1306;font:600 12px/1.3 system-ui,sans-serif}' +
      '#kb-band span{flex:1 1 150px;min-width:0}#kb-band{flex-wrap:wrap}' +
      '#kb-band button{font:inherit;color:inherit;background:rgba(0,0,0,.12);border:0;border-radius:6px;padding:3px 8px;min-height:22px;cursor:pointer}' +
      '#kb-band button.x{padding:3px 9px;font-size:14px;line-height:1}' +
      '#kb-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(5,7,10,.7);display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.45 system-ui,sans-serif}' +
      '#kb-ov div{max-width:340px;background:#161A21;color:#ECEEF3;border-radius:14px;padding:18px}' +
      '#kb-ov p{margin:0 0 14px}#kb-ov .r{display:flex;gap:8px;justify-content:flex-end}' +
      '#kb-ov button{font:600 14px system-ui,sans-serif;border:0;border-radius:10px;padding:10px 14px;background:#272D38;color:#ECEEF3;cursor:pointer}' +
      '#kb-ov button.d{background:#FF8070;color:#1A0A07}';
    document.head.appendChild(st);
    var b = document.createElement('div'); b.id = 'kb-band'; b.setAttribute('role', 'status');
    b.innerHTML = '<span>Önizleme · veriler yalnız bu telefonda</span><button type="button" class="r">Örnekleri yeniden yükle</button><button type="button" class="x" aria-label="Bandı kapat">×</button>';
    b.querySelector('.x').addEventListener('click', function () { try { sessionStorage.setItem(BAND_KEY, '1'); } catch (e) { /* yoksay */ } b.remove(); });
    b.querySelector('.r').addEventListener('click', askReset);
    document.body.insertBefore(b, document.body.firstChild);
  }
  function askReset() {
    var ov = document.createElement('div'); ov.id = 'kb-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = '<div><p><b>Örnekler yeniden yüklensin mi?</b><br>Bu telefondaki TÜM kayıtlar silinir, yerine örnek veriler gelir. Önce Yedek al ile dosyaya yedeklemeni öneririz.</p>' +
      '<div class="r"><button type="button" class="n">Vazgeç</button><button type="button" class="d y">Evet, sıfırla</button></div></div>';
    ov.querySelector('.n').addEventListener('click', function () { ov.remove(); });
    ov.querySelector('.y').addEventListener('click', function () {
      try { window.kumbaraOrnekleriYenidenYukle(); } catch (e) { ov.querySelector('p').textContent = 'Sıfırlanamadı: ' + (e && e.message); return; }
      try { localStorage.removeItem('kasa.cache.v2'); } catch (e) { /* yoksay */ }
      location.reload();
    });
    document.body.appendChild(ov);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBand); else mountBand();

  /* ---------- Service worker (yalnız https ya da localhost) ---------- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('Service worker kaydedilemedi', e); }); });
  }
})();
