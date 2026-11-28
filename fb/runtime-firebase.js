/* Kumbara Firebase çalışma zamanı.
   window.claude.use('db' | 'user' | 'downloads') arayüzünü Firestore + Google girişi üzerinde taklit eder;
   index.html değişmeden çalışır. Bu dosyada e-posta adresi ve kişi adı YOKTUR:
   - izin yalnız Firestore kuralıyla denetlenir (firebase/firestore.rules),
   - kişi adları index.html'deki PEOPLE tablosundan, kişi eşlemesi Firestore'dan (cfg/kisiler) gelir.
   Yazma/okuma sessizce yutulmaz: hata ya reddedilen söze ya da ekrandaki uyarıya gider. */
(function () {
  'use strict';
  var SDK_SURUM = '11.10.0'; // sabit sürüm; değişirse sw-firebase.js ve build.py'deki SDK_SURUM ile birlikte
  var YEREL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Yalnız localhost'ta: testlerin emülatöre ve yerel SDK kopyasına bağlanması için. Canlıda bu iki değer yok sayılır.
  var EMU = (YEREL && window.KUMBARA_FB_EMU) || null;
  var SDK_TABAN = (YEREL && window.KUMBARA_FB_SDK) || ('https://www.gstatic.com/firebasejs/' + SDK_SURUM + '/');
  var ROL_KEY = 'kumbara-fb:';       // localStorage ön eki
  var YAZMA_BEKLEME_MS = 8000;       // çevrimiçiyken yazma onayı için en çok bekleme; sonra "sırada" sayılır
  var ILK_SUNUCU_MS = 6000;          // hiç eşitlenmemiş sorguda sunucu yanıtı için en çok bekleme

  var M = null;                      // yüklenen SDK modülleri { app, auth, fs }
  var fdb = null, auth = null;
  var ME = null;                     // { uid, key, ad, owner }
  var readyRes;
  var ready = new Promise(function (res) { readyRes = res; }); // giriş + erişim + kişi eşlemesi tamamlanınca çözülür; hata olursa ekranda uyarı kalır, çözülmez
  var seq = 0;

  function err(msg, code) { var e = new Error(msg); e.code = code; return e; }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function domReady() { return document.readyState === 'loading' ? new Promise(function (r) { document.addEventListener('DOMContentLoaded', r, { once: true }); }) : Promise.resolve(); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { console.warn('localStorage okunamadı', e); return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { console.warn('localStorage yazılamadı', e); } }

  /* ---------- Günlük sunucu işlem sayacı (CLAUDE.md: ücretsiz limitin en çok %99'u, kodla zorlanır) ----------
     Cihaz başına, Pasifik saatiyle (America/Los_Angeles) gün sınırına göre, localStorage'da: Firebase ücretsiz günlük kotaları Pasifik gece yarısı sıfırlanır. Ücretsiz sınırlar: 50.000 okuma, 20.000 yazma, 20.000 silme / gün.
     İki cihaz varsayımıyla cihaz başı tavan = %99 × sınır / 2. %80'de uyarı şeridi; tavanda dinleyiciler kapanır, yazmalar reddedilir. */
  var SINIR = { r: 50000, w: 20000, x: 20000 }, CIHAZ = 2, ORAN = 0.99;
  var TAVAN = { r: Math.floor(SINIR.r * ORAN / CIHAZ), w: Math.floor(SINIR.w * ORAN / CIHAZ), x: Math.floor(SINIR.x * ORAN / CIHAZ) }; // 24750 / 9900 / 9900
  if (EMU && EMU.kota) TAVAN = Object.assign({}, TAVAN, EMU.kota); // yalnız localhost + emülatör testlerinde düşük tavan
  var KOTA_KEY = ROL_KEY + 'kota', KOTA_YAKIN = 'Günlük ücretsiz sınır doldu; yarın devam eder. Bu cihazdaki kayıtlar korunur.';
  var dinleyiciler = [], okumaKapali = false;
  function gun(d) {
    d = d || new Date();
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d); }
    catch (e) { console.warn('Saat dilimi okunamadı, UTC günü kullanılıyor', e); return d.toISOString().slice(0, 10); }
  }
  function sayac() {
    var s = null, raw = lsGet(KOTA_KEY);
    if (raw) { try { s = JSON.parse(raw); } catch (e) { console.warn('Kota sayacı okunamadı, sıfırlanıyor', e); } }
    return s && s.g === gun() ? s : { g: gun(), r: 0, w: 0, x: 0 };
  }
  function say(k, n) { var s = sayac(); s[k] += n; lsSet(KOTA_KEY, JSON.stringify(s)); kotaKontrol(s); return s; }
  function kotaKontrol(s) {
    var asan = ['r', 'w', 'x'].some(function (k) { return s[k] >= TAVAN[k]; }), yuz = Math.max(s.r / TAVAN.r, s.w / TAVAN.w, s.x / TAVAN.x);
    if (asan) uyari('kota', KOTA_YAKIN);
    uyari('kota80', !asan && yuz >= 0.8 ? 'Günlük ücretsiz sınıra yaklaşıldı (%' + Math.floor(yuz * 100) + ', bu cihaz payı).' : null);
    if (s.r >= TAVAN.r && !okumaKapali) { okumaKapali = true; dinleyiciler.slice().forEach(function (f) { f(); }); }
  }
  function kotaHata() { return Object.assign(err('Günlük sınır', 'quota_exceeded'), { userMsg: KOTA_YAKIN }); }
  function hakVar(k) { var s = sayac(); if (s[k] >= TAVAN[k]) { kotaKontrol(s); return false; } return true; }

  /* ---------- Hata eşleme: index.html'in beklediği kodlar ---------- */
  var KOTA_MSG = 'Günlük ücretsiz kullanım sınırı doldu. Bu cihazdaki kayıtlar korunur; sınır yarın sıfırlanınca açılır. Yeni kayıt şimdilik yapılamaz.';
  function hataEsle(e) {
    var c = e && e.code ? String(e.code).replace(/^firestore\//, '') : '', out = e instanceof Error ? e : err(String(e && e.message || e), c);
    out.firebaseCode = c;
    if (c === 'invalid-argument') { out.code = 'invalid_argument'; if (!out.userMsg) out.userMsg = 'Kayıt biçimi sunucuya uygun değil.'; }
    else if (c === 'resource-exhausted') { out.code = 'quota_exceeded'; out.userMsg = KOTA_MSG; uyari('kota', KOTA_MSG); }
    else if (c === 'permission-denied' || c === 'unauthenticated') { out.code = 'revoked'; erisimYok(); }
    else if (c === 'unavailable' || c === 'deadline-exceeded') out.code = 'unavailable';
    return out;
  }

  /* ---------- Arayüz: giriş, erişim yok, "sen kimsin", uyarı şeridi ---------- */
  var LOGO = '<svg viewBox="0 0 512 512" width="84" height="84" aria-hidden="true"><rect width="512" height="512" rx="120" fill="#1D2838"/><rect x="150" y="124" width="48" height="264" rx="24" fill="#EDE7DA"/><path d="M198 272 L334 136" stroke="#EDE7DA" stroke-width="48" stroke-linecap="round"/><circle cx="322" cy="334" r="64" fill="#D2AA66"/></svg>';
  var CSS =
    '#kbfb-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;' +
    'background:var(--bg,#0E1116);color:var(--fg,#ECEEF3);font:15px/1.5 Figtree,system-ui,sans-serif;overflow:auto}' +
    '#kbfb-ov .k{width:100%;max-width:340px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px}' +
    '#kbfb-ov h1{margin:6px 0 0;font:600 24px/1.2 Sora,Figtree,system-ui,sans-serif;letter-spacing:-.01em}' +
    '#kbfb-ov p{margin:0;color:var(--muted,#8C94A3)}#kbfb-ov p.m{min-height:1.5em;color:var(--fg,#ECEEF3)}' +
    '#kbfb-ov p.h{color:#FF8070}' +
    '#kbfb-ov button{font:600 15px Figtree,system-ui,sans-serif;border:0;border-radius:12px;padding:13px 18px;min-height:46px;width:100%;cursor:pointer;' +
    'background:var(--accent,#D2AA66);color:var(--accent-ink,#1A1306)}#kbfb-ov button.s{background:var(--surface2,#1E232C);color:var(--fg,#ECEEF3)}' +
    '#kbfb-ov button:disabled{opacity:.55;cursor:default}#kbfb-ov button:focus-visible{outline:2px solid var(--fg,#ECEEF3);outline-offset:2px}' +
    '#kbfb-ov .l{display:flex;flex-direction:column;gap:10px;width:100%}' +
    '#kbfb-st{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(88px + env(safe-area-inset-bottom,0px));z-index:2147482000;width:max-content;max-width:min(92vw,420px);box-sizing:border-box;' +
    'display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:12px;background:#F0B44C;color:#1A1306;font:600 12px/1.35 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35)}' +
    '#kbfb-st.e{background:#FF8070}#kbfb-st button{font:inherit;border:0;background:rgba(0,0,0,.14);color:inherit;border-radius:8px;padding:2px 8px;cursor:pointer}';
  var ov = null, st = null;
  function addCss() { if (document.getElementById('kbfb-css')) return; var s = document.createElement('style'); s.id = 'kbfb-css'; s.textContent = CSS; document.head.appendChild(s); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function showOv(build) {
    return domReady().then(function () {
      addCss();
      if (!ov) { ov = el('div'); ov.id = 'kbfb-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); document.body.appendChild(ov); }
      ov.textContent = '';
      var k = el('div', 'k'); var lg = el('div'); lg.innerHTML = LOGO; k.appendChild(lg);
      build(k); ov.appendChild(k); return k;
    });
  }
  function hideOv() { if (ov) { ov.remove(); ov = null; } }
  function btn(text, fn, cls) { var b = el('button', cls || '', text); b.type = 'button'; b.addEventListener('click', fn); return b; }

  /* Uyarı şeridi: çevrimdışı / sırada bekleyen yazma / hata. kind: 'cevrimdisi' | 'bekleyen' | 'kota' | 'yazma' | 'onbellek' */
  var uyarilar = {};
  function uyari(kind, msg) { if (msg) uyarilar[kind] = msg; else delete uyarilar[kind]; cizUyari(); }
  function cizUyari() {
    domReady().then(function () {
      var keys = Object.keys(uyarilar);
      if (!keys.length) { if (st) { st.remove(); st = null; } return; }
      addCss();
      if (!st) { st = el('div'); st.id = 'kbfb-st'; st.setAttribute('role', 'status'); document.body.appendChild(st); }
      var kind = ['kota', 'yazma', 'dinleyici', 'cevrimdisi', 'bekleyen', 'onbellek', 'kota80'].filter(function (k) { return uyarilar[k]; })[0], hata = kind === 'kota' || kind === 'yazma';
      st.className = hata ? 'e' : ''; st.textContent = '';
      st.appendChild(el('span', '', uyarilar[kind]));
      if (hata) st.appendChild(btn('Tamam', function () { delete uyarilar[kind]; cizUyari(); }));
    });
  }
  var bekleyen = 0;
  function bekleyenGuncelle() {
    var off = typeof navigator !== 'undefined' && navigator.onLine === false;
    uyari('cevrimdisi', off ? 'Çevrimdışı · değişiklikler bu cihazda saklanıyor' + (bekleyen ? ' (' + bekleyen + ' sırada)' : '') : null);
    uyari('bekleyen', !off && bekleyen ? 'Sunucuya yazılıyor… (' + bekleyen + ')' : null);
  }
  window.addEventListener('online', bekleyenGuncelle); window.addEventListener('offline', bekleyenGuncelle);

  var erisimYokGosterildi = false;
  function erisimYok() {
    if (erisimYokGosterildi) return; erisimYokGosterildi = true;
    var mail = auth && auth.currentUser && auth.currentUser.email;
    showOv(function (k) {
      k.appendChild(el('h1', '', 'Bu hesabın erişim izni yok'));
      k.appendChild(el('p', '', mail ? mail + ' hesabıyla giriş yapıldı, ama bu hesap Kumbara verisine erişemez.' : 'Bu hesap Kumbara verisine erişemez.'));
      k.appendChild(btn('Çıkış yap', function () { cikis(); }));
    });
  }
  function cikis() {
    var p = auth ? M.auth.signOut(auth) : Promise.resolve();
    return p.then(function () { location.reload(); }, function (e) { console.error(e); uyari('yazma', 'Çıkış yapılamadı: ' + (e && e.message)); });
  }

  /* ---------- SDK ve başlatma ---------- */
  async function yukleSdk() {
    var cfg = await import(new URL('firebase-config.js', document.baseURI).href);
    var mods = await Promise.all([import(SDK_TABAN + 'firebase-app.js'), import(SDK_TABAN + 'firebase-auth.js'), import(SDK_TABAN + 'firebase-firestore.js')]);
    M = { app: mods[0], auth: mods[1], fs: mods[2], cfg: cfg.firebaseConfig };
  }
  function baslat() {
    var app = M.app.initializeApp(M.cfg);
    auth = M.auth.getAuth(app);
    var fsOpts = { experimentalAutoDetectLongPolling: true };
    try { fsOpts.localCache = M.fs.persistentLocalCache({ tabManager: M.fs.persistentMultipleTabManager() }); fdb = M.fs.initializeFirestore(app, fsOpts); }
    catch (e) {
      console.error('Kalıcı önbellek açılamadı, bellek önbelleği kullanılıyor', e);
      uyari('onbellek', 'Çevrimdışı önbellek açılamadı; internetsiz çalışma sınırlı.');
      fsOpts.localCache = M.fs.memoryLocalCache(); fdb = M.fs.initializeFirestore(app, fsOpts);
    }
    if (EMU) { M.auth.connectAuthEmulator(auth, EMU.auth, { disableWarnings: true }); M.fs.connectFirestoreEmulator(fdb, EMU.firestore.host, EMU.firestore.port); }
  }
  function ilkKullanici() { // kayıtlı oturum varsa hemen, yoksa null
    return new Promise(function (res) { var un = M.auth.onAuthStateChanged(auth, function (u) { un(); res(u); }); });
  }
  function girisBekle() { // giriş olana kadar bekler
    return new Promise(function (res) { var un = M.auth.onAuthStateChanged(auth, function (u) { if (u) { un(); res(u); } }); });
  }
  function mobilStandalone() {
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios && (navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  }
  var GIRIS_MSG = {
    'auth/popup-closed-by-user': 'Giriş penceresi kapatıldı. Tekrar dene.', 'auth/cancelled-popup-request': 'Giriş penceresi kapatıldı. Tekrar dene.',
    'auth/network-request-failed': 'İnternet bağlantısı yok. Giriş için internet gerekir.',
    'auth/unauthorized-domain': 'Bu adres Firebase konsolunda yetkili alan adları arasında değil (Authentication > Settings > Authorized domains).',
    'auth/operation-not-allowed': 'Google girişi Firebase konsolunda açık değil.'
  };
  async function girisSayfasi(ilk) {
    var msg = ilk || '', pm = null, b = null;
    await showOv(function (k) {
      k.appendChild(el('h1', '', 'Kumbara'));
      k.appendChild(el('p', '', 'Devam etmek için Google hesabınla giriş yap.'));
      var l = el('div', 'l'); b = btn('Google ile giriş yap', async function () {
        b.disabled = true; pm.textContent = ''; pm.className = 'm';
        var prov = new M.auth.GoogleAuthProvider();
        try {
          // Yalnız localhost + emülatör testlerinde: Google penceresi (apis.google.com) olmadan sahte Google kimliğiyle giriş. Canlıda EMU yok, bu dal çalışmaz.
          if (EMU && EMU.idToken) { await M.auth.signInWithCredential(auth, M.auth.GoogleAuthProvider.credential(EMU.idToken)); return; }
          if (mobilStandalone()) { await M.auth.signInWithRedirect(auth, prov); return; }
          await M.auth.signInWithPopup(auth, prov);
        } catch (e) {
          console.error(e);
          if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
            try { await M.auth.signInWithRedirect(auth, prov); return; } catch (e2) { console.error(e2); e = e2; }
          }
          pm.className = 'm h'; pm.textContent = GIRIS_MSG[e && e.code] || ('Giriş yapılamadı' + (e && e.code ? ' (' + e.code + ')' : '') + '.'); b.disabled = false;
        }
      });
      l.appendChild(b); k.appendChild(l); pm = el('p', 'm' + (msg ? ' h' : ''), msg); pm.setAttribute('role', 'alert'); k.appendChild(pm);
    });
  }

  /* ---------- Erişim denetimi ve kişi eşlemesi (cfg/kisiler) ---------- */
  function kisiTablosu() { // index.html'deki PEOPLE: kişi anahtarı ve görünen ad. Çalışma zamanında ad gömülü değil.
    try {
      var p = window.kumbaraKisiler || null; // index.html kişi tablosunu burada paylaşır (CSP altında eval gerekmesin)
      return p ? Object.keys(p).map(function (k) { return { key: k, ad: (p[k] && p[k].n) || k }; }) : null;
    } catch (e) { console.error('PEOPLE okunamadı', e); return null; }
  }
  var kisilerRef = function () { return M.fs.doc(fdb, 'cfg', 'kisiler'); };
  async function kisilerOku() { // sunucudan; ulaşılamazsa önbellekten. permission-denied yukarı atılır.
    try { return await M.fs.getDocFromServer(kisilerRef()); }
    catch (e) {
      var c = e && e.code;
      if (c === 'permission-denied' || c === 'unauthenticated') throw e;
      console.warn('cfg/kisiler sunucudan okunamadı, önbellek deneniyor', e);
      return await M.fs.getDocFromCache(kisilerRef()); // önbellekte de yoksa bu da atar (ilk girişte internet şart)
    }
  }
  async function kimsin(uid, tablo) {
    var secilen = null, done, p = new Promise(function (r) { done = r; });
    await showOv(function (k) {
      k.appendChild(el('h1', '', 'Sen kimsin?'));
      k.appendChild(el('p', '', 'Bu hesabı hangi kişiyle eşleyelim? Bu seçim bir kez sorulur ve kayıtlarda senin adına yazılır.'));
      var l = el('div', 'l'), m = el('p', 'm'); m.setAttribute('role', 'alert');
      tablo.forEach(function (t) {
        var b = btn(t.ad, function () {
          Array.prototype.forEach.call(l.children, function (x) { x.disabled = true; }); m.textContent = ''; m.className = 'm';
          M.fs.runTransaction(fdb, async function (tx) {
            var s = await tx.get(kisilerRef()), map = (s.exists() && s.data().map) || {};
            Object.keys(map).forEach(function (u) { if (u !== uid && map[u] === t.key) throw err('Bu kişi başka bir hesapla eşlenmiş.', 'kisi-dolu'); });
            tx.set(kisilerRef(), { map: Object.assign({}, map, (function () { var o = {}; o[uid] = t.key; return o; })()) }, { merge: true });
          }).then(function () { secilen = t.key; done(); }, function (e) {
            console.error(e);
            m.className = 'm h'; m.textContent = e && e.code === 'kisi-dolu' ? e.message : 'Kaydedilemedi, internet bağlantını kontrol edip tekrar dene.';
            Array.prototype.forEach.call(l.children, function (x) { x.disabled = false; });
          });
        }, 's'); l.appendChild(b);
      });
      k.appendChild(l); k.appendChild(m);
    });
    await p; return secilen;
  }
  async function kimlikKur(u) {
    var s;
    try { s = await kisilerOku(); }
    catch (e) {
      if (e && (e.code === 'permission-denied' || e.code === 'unauthenticated')) { erisimYok(); return new Promise(function () { /* kullanıcı çıkış yapana kadar bekler */ }); }
      throw e;
    }
    var tablo = null, tries = 0;
    while (!(tablo = kisiTablosu()) && tries++ < 50) await new Promise(function (r) { setTimeout(r, 100); });
    if (!tablo || !tablo.length) throw err('Kişi tablosu (PEOPLE) bulunamadı.', 'kisi-yok');
    var map = (s.exists() && s.data().map) || {}, key = map[u.uid];
    if (!key || !tablo.some(function (t) { return t.key === key; })) key = await kimsin(u.uid, tablo);
    var t0 = tablo.filter(function (t) { return t.key === key; })[0];
    return { uid: u.uid, key: key, ad: t0.ad, owner: tablo[0].key === key };
  }

  async function giris() {
    try {
      await yukleSdk();
    } catch (e) {
      console.error(e);
      await showOv(function (k) {
        k.appendChild(el('h1', '', 'Kumbara açılamadı'));
        k.appendChild(el('p', 'h', 'Uygulama bileşenleri yüklenemedi. İlk açılışta internet gerekir.'));
        k.appendChild(btn('Tekrar dene', function () { location.reload(); }));
      });
      return new Promise(function () { /* yeniden yüklemeyi bekler */ });
    }
    baslat();
    if (/[?&]cikis=1\b/.test(location.search)) { await M.auth.signOut(auth); history.replaceState(null, '', location.pathname + location.hash); }
    try { await M.auth.getRedirectResult(auth); } catch (e) { console.error(e); await girisSayfasi(GIRIS_MSG[e && e.code] || ('Giriş yapılamadı' + (e && e.code ? ' (' + e.code + ')' : '') + '.')); }
    var u = await ilkKullanici();
    if (!u) { if (!ov) await girisSayfasi(); u = await girisBekle(); }
    for (;;) {
      try { ME = await kimlikKur(u); break; }
      catch (e) {
        console.error(e);
        await showOv(function (k) {
          var msg = e && e.code === 'kisi-yok' ? 'Kişi tablosu bulunamadı.' : 'Hesap bilgisi alınamadı. İlk girişte internet bağlantısı gerekir.';
          k.appendChild(el('h1', '', 'Giriş tamamlanamadı')); k.appendChild(el('p', 'h', msg));
          k.appendChild(btn('Tekrar dene', function () { location.reload(); })); k.appendChild(btn('Çıkış yap', function () { cikis(); }, 's'));
        });
        return new Promise(function () { /* kullanıcı seçene kadar bekler */ });
      }
    }
    hideOv();
    M.auth.onAuthStateChanged(auth, function (nu) { if (!nu || nu.uid !== ME.uid) location.reload(); }); // başka sekmede çıkış / hesap değişimi
    bekleyenGuncelle();
    readyRes();
  }

  /* ---------- db: Firestore üzerinde yerel taklidin aynı arayüzü ---------- */
  function wrapDoc(s) { return { id: s.id, exists: s.exists(), fromCache: !!(s.metadata && s.metadata.fromCache), data: function () { return s.exists() ? s.data() : undefined; } }; }
  function wrapQ(s) {
    var docs = s.docs.map(wrapDoc);
    return { docs: docs, size: docs.length, empty: !docs.length, fromCache: !!s.metadata.fromCache, forEach: function (f) { docs.forEach(f); } };
  }
  /* Yazma: çevrimiçiyken sunucu onayını (en çok YAZMA_BEKLEME_MS) bekler; çevrimdışıyken yerel önbelleğe yazılır ve hemen tamamlanır.
     Sonradan sunucu reddederse sessiz kalmaz: uyarı şeridi + konsol. */
  var AD = { tx: 'kayıt', inv: 'yatırım kaydı', led: 'defter kalemi', rec: 'tekrarlayan kayıt', cfg: 'ayar', log: 'etkinlik günlüğü kaydı', ext: 'varlık kaydı' };
  function yazMesaj(aciklama, h) { // belge yolu değil, sade açıklama
    var ad = AD[String(aciklama || '').split('/')[0]] || 'kayıt', neden = h.userMsg;
    if (!neden) neden = h.firebaseCode === 'not-found' ? 'kayıt sunucuda bulunamadı.' : h.code === 'revoked' ? 'erişim yok.' : 'sunucu isteği kabul etmedi.';
    return 'Bir ' + ad + ' sunucuya yazılamadı: ' + neden;
  }
  function yaz(thunk, aciklama, tur) {
    tur = tur || 'w';
    if (!hakVar(tur)) return Promise.reject(kotaHata());
    var promise;
    try { promise = thunk(); } catch (e) { return Promise.reject(hataEsle(e)); } // SDK bazı geçersiz verileri (iç içe dizi vb.) eşzamanlı reddeder
    say(tur, 1);
    bekleyen++; bekleyenGuncelle();
    var bitti = false;
    function son() { if (!bitti) { bitti = true; bekleyen--; bekleyenGuncelle(); } }
    return new Promise(function (res, rej) {
      var gec = false, t = null;
      promise.then(function () { son(); if (t) clearTimeout(t); if (!gec) res(); }, function (e) {
        son(); if (t) clearTimeout(t); var h = hataEsle(e);
        if (!gec) rej(h); else { console.error('Sonradan reddedilen yazma:', aciklama, e); uyari('yazma', yazMesaj(aciklama, h)); }
      });
      var off = navigator.onLine === false;
      t = setTimeout(function () { gec = true; res(); }, off ? 0 : YAZMA_BEKLEME_MS);
    });
  }
  function sigDeger(v) { // her değer imzaya girer; ms zaman damgaları gün düzeyine yuvarlanır (log penceresi her açılışta değişmesin)
    if (typeof v === 'number') return String(v >= 1e11 ? Math.floor(v / 864e5) + 'g' : v);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  function sig(c, filters, lim) { return c + '|' + filters.map(function (f) { return f[0] + f[1] + sigDeger(f[2]); }).join('&') + '|' + (lim == null ? '' : lim); }
  /* Dinleyici: ilk anlık görüntü önbellekten gelirse ve bu sorgu bu cihazda hiç sunucuyla eşitlenmediyse (eksik önbellek olabilir)
     sunucu yanıtı (en çok ILK_SUNUCU_MS) beklenir; daha önce eşitlenmişse önbellek hemen verilir (hızlı ve internetsiz açılış). */
  /* Dinleyici hatası: uygulama kendi hata yoluna (ecb) gider. Ayrıca bu oturumda srvOk açılamayabileceği için (otomatik tekrarlayan/abonelik/defter işleri atlanır) şeritte bir kez bildirilir. */
  function dinleHata(e, ecb) {
    var h = hataEsle(e); console.error(e);
    if (h.code !== 'revoked' && h.code !== 'quota_exceeded') uyari('dinleyici', 'Bir veri kaynağı açılamadı; otomatik işlemler (tekrarlayan kayıt, abonelik, defter) bu oturumda atlanabilir. Sayfayı yenile.');
    if (ecb) { try { ecb(h); } catch (x) { console.error(x); } }
  }
  function dinle(target, cevir, imza, cb, ecb) {
    var okKey = ROL_KEY + 'ok:' + (ME ? ME.uid : '') + ':' + imza, delivered = false, srvDelivered = false, held = null, timer = null, lastSig = null, kapali = false, senk = false, un = null;
    if (okumaKapali || !hakVar('r')) { setTimeout(function () { if (ecb) { try { ecb(kotaHata()); } catch (x) { console.error(x); } } }, 0); return function () {}; }
    function kapat() { kapali = true; if (timer) clearTimeout(timer); if (un) un(); var i = dinleyiciler.indexOf(kapat); if (i >= 0) dinleyiciler.splice(i, 1); }
    function ver(s, sg) { delivered = true; lastSig = sg; if (!s.metadata.fromCache) srvDelivered = true; try { cb(cevir(s)); } catch (e) { console.error(e); } }
    un = M.fs.onSnapshot(target, { includeMetadataChanges: true }, function (s) {
      var fromCache = s.metadata.fromCache, sg, degisti, n = 0;
      if (kapali) return;
      sg = s.docs ? 'q' : (s.exists() ? JSON.stringify(s.data()) : '\u0000yok');
      degisti = s.docs ? s.docChanges().length > 0 : sg !== lastSig;
      if (!fromCache) { // sunucudan gelen belgeler sayılır: ilk sunucu görüntüsü (soğuk açılış varsayımı) tümü, sonrakiler yalnız değişenler
        if (timer) { clearTimeout(timer); timer = null; }
        if (!senk) { senk = true; lsSet(okKey, '1'); n = s.docs ? Math.max(1, s.size) : 1; } else if (degisti) n = s.docs ? s.docChanges().length : 1;
        if (n) say('r', n);
        if (kapali) return;
      }
      // Sunucu görüntüsü ilk kez geldiyse (önbellek görüntüsü aynı veriyle daha önce verilmiş olsa bile) yeniden bildirilir: fromCache=false
      var zorla = !fromCache && !srvDelivered;
      if (delivered && !zorla && !degisti) return;
      if (!fromCache || delivered || lsGet(okKey) === '1') { held = null; ver(s, sg); return; }
      held = [s, sg];
      if (!timer) timer = setTimeout(function () { timer = null; if (held && !kapali) { var h = held; held = null; ver(h[0], h[1]); } }, ILK_SUNUCU_MS);
    }, function (e) { if (timer) clearTimeout(timer); dinleHata(e, ecb); });
    dinleyiciler.push(kapat);
    return kapat;
  }
  function pathParts(path) { var i = String(path).indexOf('/'); return [path.slice(0, i), path.slice(i + 1)]; }
  function docRef(path) {
    var pp = pathParts(path), c = pp[0], id = pp[1], aciklama = path;
    function r() { return M.fs.doc(fdb, c, id); }
    return {
      id: id, path: path,
      get: async function () {
        var s;
        if (!hakVar('r')) throw kotaHata();
        try { s = await M.fs.getDoc(r()); } catch (e) { throw hataEsle(e); }
        if (!s.metadata.fromCache) say('r', 1);
        // Sunucuya ulaşılamayıp önbellekten gelen kopya "taze" sayılmaz: bayat kopya üstüne tüm belge yazılıp sonradan diğer kişinin değişikliğini ezmesin.
        if (s.metadata.fromCache) throw Object.assign(err('Çevrimdışı: belge taze okunamadı.', 'unavailable'), { userMsg: 'Çevrimdışıyken bu ayar değişikliği yapılamaz; internete bağlanınca tekrar dene.' });
        return wrapDoc(s);
      },
      set: function (d) { var v = clone(d); return yaz(function () { return M.fs.setDoc(r(), v); }, aciklama); },
      update: function (d) {
        var p = clone(d) || {}, ks = Object.keys(p);
        return yaz(function () {
          if (!ks.length) return M.fs.updateDoc(r(), {});
          var args = []; ks.forEach(function (k) { args.push(new M.fs.FieldPath(k), p[k]); }); // anahtarlar harfiyen (noktalar yol sayılmaz)
          return M.fs.updateDoc.apply(null, [r()].concat(args));
        }, aciklama);
      },
      delete: function () { return yaz(function () { return M.fs.deleteDoc(r()); }, aciklama, 'x'); },
      onSnapshot: function (cb, ecb) { return dinle(r(), wrapDoc, 'd:' + path, cb, ecb); }
    };
  }
  var OPS = { '>=': 1, '<': 1, '==': 1, '>': 1, '<=': 1, '!=': 1, 'in': 1 };
  function newId() { return 'a' + Date.now().toString(36) + (++seq).toString(36) + Math.random().toString(36).slice(2, 7); }
  function query(c, filters, lim, order) {
    function build() {
      var parts = filters.map(function (f) { return M.fs.where(f[0], f[1], f[2]); });
      order.forEach(function (o) { parts.push(M.fs.orderBy(o[0], o[1])); });
      if (lim != null) parts.push(M.fs.limit(lim));
      return M.fs.query.apply(null, [M.fs.collection(fdb, c)].concat(parts));
    }
    var q = {
      where: function (f, o, v) { if (!OPS[o]) throw err('Desteklenmeyen işleç: ' + o, 'invalid_argument'); return query(c, filters.concat([[f, o, v]]), lim, order); },
      limit: function (l) { return query(c, filters, l, order); },
      orderBy: function (f, dir) { return query(c, filters, lim, order.concat([[f, dir === 'desc' ? 'desc' : 'asc']])); },
      get: async function () {
        if (!hakVar('r')) throw kotaHata();
        var s; try { s = await M.fs.getDocs(build()); } catch (e) { throw hataEsle(e); }
        if (!s.metadata.fromCache) say('r', Math.max(1, s.size));
        return wrapQ(s);
      },
      onSnapshot: function (cb, ecb) { return dinle(build(), wrapQ, 'q:' + sig(c, filters, lim), cb, ecb); },
      doc: function (id) { return docRef(c + '/' + (id || newId())); },
      add: function (d) { var id = newId(), v = clone(d); return yaz(function () { return M.fs.setDoc(M.fs.doc(fdb, c, id), v); }, c + '/' + id).then(function () { return docRef(c + '/' + id); }); }
    };
    return q;
  }
  var db = { collection: function (c) { return query(c, [], null, []); }, doc: docRef };

  /* ---------- user ve downloads ---------- */
  var user = {
    isOwner: function () { return ready.then(function () { return ME.owner; }); },
    canEdit: function () { return ready.then(function () { return true; }); },
    can: function () { return ready.then(function () { return true; }); }, // erişimi olan herkes yazabilir (kural: iki izinli hesap)
    id: function () { return ready.then(function () { return ME.uid; }); },
    me: function () { return ready.then(function () { return { id: ME.uid, name: ME.ad, key: ME.key }; }); },
    profiles: function () { return ready.then(function () { var t = kisiTablosu() || []; return t.map(function (x) { return { id: x.key, name: x.ad }; }); }); }
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

  window.claude = {
    use: function (name) {
      if (name === 'downloads') return Promise.resolve(downloads);
      if (name === 'db') return ready.then(function () { return db; });
      if (name === 'user') return ready.then(function () { return user; });
      return Promise.resolve(null);
    }
  };
  window.kumbaraFb = { cikis: cikis, hataEsle: hataEsle, sig: sig, dinleHata: dinleHata, gunDe: function (ms) { return gun(new Date(ms)); }, kota: function () { var s = sayac(); return { gun: s.g, r: s.r, w: s.w, x: s.x, tavan: TAVAN }; } };

  giris().catch(function (e) { console.error(e); showOv(function (k) { k.appendChild(el('h1', '', 'Kumbara açılamadı')); k.appendChild(el('p', 'h', 'Beklenmeyen hata: ' + (e && e.message))); k.appendChild(btn('Tekrar dene', function () { location.reload(); })); }); });

  /* Service worker (yalnız https ya da localhost) */
  if ('serviceWorker' in navigator && !window.KUMBARA_FB_SW_OFF) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('Service worker kaydedilemedi', e); }); });
  }
})();
