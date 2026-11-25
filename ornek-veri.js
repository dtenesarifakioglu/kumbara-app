/* ÖRNEK VERİ: tamamen uydurmadır; gerçek kişi, kart ya da tutar içermez.
   Tarihler "bugüne" göre üretilir, uygulama her zaman güncel görünür.
   window.KUMBARA_ORNEK(now) -> { koleksiyon: { belgeId: {...} } } */
(function () {
  'use strict';
  window.KUMBARA_ORNEK = function (now) {
    now = now || new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var Y = now.getFullYear(), M0 = now.getMonth();
    var iso = function (t) { return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); };
    var dstr = function (y, m, d) { return iso(new Date(y, m, d)); };
    var today = iso(now);
    var data = { tx: {}, inv: {}, ext: {}, rec: {}, log: {}, led: {}, cfg: {} };
    var n = 0;
    var addTx = function (o) {
      data.tx['ornek_t' + (++n)] = Object.assign({ shared: false, pay: '', note: '', sub: '', created: now.getTime() - n * 1000 }, o);
    };
    // Son 5 ay: maaş, kira, günlük harcamalar, abonelikler, birikim
    for (var k = 4; k >= 0; k--) {
      var m = M0 - k;
      addTx({ type: 'gelir', amount: 42000, cat: 'maas', note: 'ÖRNEK maaş', date: dstr(Y, m, 1), by: 'k1' });
      addTx({ type: 'gelir', amount: 18000, cat: 'maas', note: 'ÖRNEK maaş 2', date: dstr(Y, m, 3), by: 'k2' });
      addTx({ type: 'gider', amount: 6500, cat: 'ev', note: 'ÖRNEK kira', date: dstr(Y, m, 5), by: 'k1', shared: true, pay: 'nakit' });
      [[2, 'market', 1450.75, 'ÖRNEK market', 'k1', 'yk'], [7, 'yiyecek', 320, 'ÖRNEK yemek', 'k2', 'ziraat'],
        [10, 'market', 980.5, 'ÖRNEK market 2', 'k2', 'yk'], [12, 'fatura', 640, 'ÖRNEK elektrik', 'k1', 'nakit'],
        [15, 'ulasim', 250, 'ÖRNEK otobüs', 'k2', 'nakit'], [18, 'giyim', 2100, 'ÖRNEK giysi', 'k1', 'ziraat'],
        [21, 'saglik', 450, 'ÖRNEK eczane', 'k2', 'yk'], [24, 'sosyal', 780, 'ÖRNEK sinema ve akşam yemeği', 'k1', 'yk']
      ].forEach(function (r) {
        addTx({ type: 'gider', amount: r[2], cat: r[1], note: r[3], date: dstr(Y, m, r[0]), by: r[4], pay: r[5], shared: r[0] % 2 === 0 });
      });
      addTx({ type: 'gider', amount: 149.9, cat: 'abonelik', sub: 's1', note: 'ÖRNEK Müzik', date: dstr(Y, m, 9), by: 'k1', pay: 'yk' });
      addTx({ type: 'gider', amount: 229.99, cat: 'abonelik', sub: 's2', note: 'ÖRNEK Video', date: dstr(Y, m, 14), by: 'k2', pay: 'yk' });
      addTx({ type: 'birikim', amount: 3000, cat: 'birikim', note: 'ÖRNEK ALTIN', date: dstr(Y, m, 4), by: 'k1', invId: 'i1' });
    }
    // Taksit örneği
    for (var i = 0; i < 6; i++) addTx({ type: 'gider', amount: 1500, cat: 'alisveris', note: 'ÖRNEK telefon taksidi', date: dstr(Y, M0 - 2 + i, 16), by: 'k1', pay: 'yk', inst: { i: i + 1, n: 6, g: 'ornek_g1' } });

    data.inv = {
      i1: { kind: 'altin', valor: 0, code: 'ALTIN', name: 'ÖRNEK Altın', units: 12.5, price: 3400, cost: 38000, updated: now.getTime(), basePrice: 3300, baseDate: dstr(Y, M0 - 4, 1), lots: [] },
      i2: { kind: 'doviz', valor: 0, code: 'USD', name: 'ÖRNEK Dolar', units: 500, price: 42, cost: 19000, updated: now.getTime(), basePrice: 40, baseDate: dstr(Y, M0 - 4, 1), lots: [] }
    };
    data.rec = { r1: { type: 'gider', amount: 149.9, cat: 'abonelik', sub: 's1', note: 'ÖRNEK Müzik', by: 'k1', freq: 'monthly', weekday: null, day: 9, commit: true, active: true, lastRun: dstr(Y, M0, 9) } };
    data.led = {
      l1: { who: 'ÖRNEK Ali', dir: 'alacak', amount: 1200, note: 'ÖRNEK borç', date: dstr(Y, M0, 20), by: 'k1', paid: false, created: now.getTime() },
      l2: { who: 'ÖRNEK Veli', dir: 'borc', amount: 800, note: 'ÖRNEK ödünç', date: dstr(Y, M0 + 1, 2), by: 'k2', paid: false, created: now.getTime() }
    };

    // Son 2 ayın günlük örnek fiyatları (Varlıklar ekranındaki grafik ve Bugün/Bu hafta/Bu ay için)
    var daily = function (start, end, wiggle) {
      var out = {}, d = new Date(now.getFullYear(), now.getMonth() - 2, now.getDate()), steps = 0;
      var total = Math.max(1, Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - d) / 864e5));
      while (iso(d) <= today) {
        var v = start + (end - start) * (steps / total) + Math.sin(steps * 0.9) * wiggle;
        out[iso(d)] = Math.round(v * 100) / 100; d.setDate(d.getDate() + 1); steps++;
      }
      out[today] = end; // son gün = envanterdeki güncel fiyat
      return out;
    };
    data.cfg = {
      main: { cancelled: {}, subsMeta: {}, cards: { yk: { cut: 15, due: 25, limit: 40000 }, ziraat: { cut: 10, due: 20, limit: 30000 } } },
      ledger: { rules: [], people: ['ÖRNEK Ali', 'ÖRNEK Veli'] },
      subs: { map: { abonelik: [{ id: 's1', n: 'ÖRNEK Müzik' }, { id: 's2', n: 'ÖRNEK Video' }] } },
      market: { assets: {
        KZL: { name: 'ÖRNEK Altın', daily: daily(3250, 3400, 18) },
        USD: { name: 'ÖRNEK Dolar', daily: daily(40.2, 42, 0.15) }
      } }
    };
    return data;
  };
})();
