/* Kumbara önizleme service worker. build.py 1b9fad3ea9ee ve ["./", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "index.html", "manifest.webmanifest", "ornek-veri.js", "pdf.min.mjs", "pdf.worker.min.mjs", "runtime.js"] yerlerini doldurur. */
const SURUM = '1b9fad3ea9ee';
const KABUK_ONBELLEK = 'kumbara-kabuk-' + SURUM;
const FONT_ONBELLEK = 'kumbara-font-v1';
const KABUK = ["./", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "index.html", "manifest.webmanifest", "ornek-veri.js", "pdf.min.mjs", "pdf.worker.min.mjs", "runtime.js"];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(KABUK_ONBELLEK).then((c) => c.addAll(KABUK)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Eski sürümün kabuk önbelleklerini sil (font önbelleği sürümden bağımsız kalır)
    for (const k of await caches.keys()) if (k.startsWith('kumbara-kabuk-') && k !== KABUK_ONBELLEK) await caches.delete(k);
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
