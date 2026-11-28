/* Kumbara (Firebase sürümü) service worker. build.py 79630e64b5b6, ["./", "firebase-config.js", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "index.html", "manifest.webmanifest", "pdf.min.mjs", "pdf.worker.min.mjs", "runtime-firebase.js"] ve 11.10.0 yerlerini doldurur.
   Önizleme sw.js'inden farkı: Firebase SDK dosyaları (sabit sürümlü, değişmez) ilk indirmeden sonra önbellekten verilir; böylece internetsiz açılış çalışır. */
const SURUM = '79630e64b5b6';
const KABUK_ONBELLEK = 'kumbara-kabuk-' + SURUM;
const FONT_ONBELLEK = 'kumbara-font-v1';
const SDK_ONBELLEK = 'kumbara-sdk-11.10.0';
const SDK_YOL = '/firebasejs/11.10.0/';
const SDK_ILK = ['app', 'auth', 'firestore'].map((n) => 'https://www.gstatic.com' + SDK_YOL + 'firebase-' + n + '.js');
const KABUK = ["./", "firebase-config.js", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "index.html", "manifest.webmanifest", "pdf.min.mjs", "pdf.worker.min.mjs", "runtime-firebase.js"];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(KABUK_ONBELLEK)).addAll(KABUK);
    // SDK'yı kurulumda önden indir: ilk oturumdan sonra internetsiz açılış çalışsın. Olmazsa kurulum bozulmaz, ilk kullanımda önbelleğe girer.
    try { await (await caches.open(SDK_ONBELLEK)).addAll(SDK_ILK); } catch (err) { console.warn('SDK önden indirilemedi', err); }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Eski sürümün kabuk önbelleklerini sil (font önbelleği sürümden bağımsız kalır)
    for (const k of await caches.keys()) if ((k.startsWith('kumbara-kabuk-') && k !== KABUK_ONBELLEK) || (k.startsWith('kumbara-sdk-') && k !== SDK_ONBELLEK)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const FONT_HOST = /^(fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: önbellekten ver, arkada yenile (stale-while-revalidate)
  if (FONT_HOST.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(FONT_ONBELLEK), hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || Response.error();
    })());
    return;
  }

  // Firebase SDK (sabit sürüm yolu): önbellek önce, yoksa ağdan alıp sakla
  if (url.pathname.startsWith(SDK_YOL)) {
    e.respondWith((async () => {
      const c = await caches.open(SDK_ONBELLEK), hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r && r.ok) await c.put(req, r.clone());
      return r;
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // Uygulama kabuğu: önbellek önce; sayfa gezintisi çevrimdışıyken index.html'e düşer
  e.respondWith((async () => {
    const c = await caches.open(KABUK_ONBELLEK);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); }
    catch (err) {
      if (req.mode === 'navigate') { const idx = await c.match('./index.html'); if (idx) return idx; }
      return Response.error();
    }
  })());
});
