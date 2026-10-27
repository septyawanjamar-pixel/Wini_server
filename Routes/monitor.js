/**
 * Data website monitoring (dashboard.html)
 *
 *   GET /api/monitor?area=&hari=30
 *     area  -> nama atau id tabel Area (kosong = semua area)
 *     hari  -> panjang grafik WIP harian (default 30 hari terakhir, max 180)
 *
 * Isi balasan (semua dipakai dashboard.html):
 *   kpi            -> hari_ini, input_hari_ini, wip_lewat (lot IN yang lewat lead time area-nya)
 *   status_area    -> daftar area (untuk pilihan filter)
 *   peta_posisi    -> per area: tiap nomor posisi kosong / terisi lot apa
 *   posisi_ringkas -> total / terisi / kosong semua posisi
 *   input_terbaru  -> 30 input terakhir (dari scan_log) + status lot sekarang
 *   wip_harian     -> jumlah WIP di akhir tiap hari + masuk / keluar per hari
 *
 * Aturan:
 *   - waktu tunggu (stagnasi) dihitung per TANGGAL: IN -> sampai hari ini, OUT -> sampai tanggal output
 *   - lead time per area dari tabel Batas_Lead_Time; lewat lead time = stagnasi > lead time
 */
const express = require('express');

module.exports = (db, { LEAD_TIME_HARI = 4, posisi } = {}) => {
  const router = express.Router();
  const LT = Number(LEAD_TIME_HARI);

  const STAG = `CAST(julianday(COALESCE(date(s.tanggal_output), date('now','localtime'))) - julianday(date(s.tanggal_input)) AS INTEGER)`;

  /** ?area= -> id Area (atau null = semua) */
  function areaId(input) {
    const v = String(input ?? '').trim();
    if (!v) return null;
    if (/^\d+$/.test(v)) return Number(v);
    const norm = (x) => String(x ?? '').toLowerCase().replace(/^area\s+/, '').replace(/[^a-z0-9]/g, '');
    const row = db.prepare('SELECT id, lokasi FROM Area').all().find((r) => norm(r.lokasi) === norm(v));
    return row ? row.id : -1; // -1 = area tidak dikenal -> data kosong
  }

  router.get('/', (req, res) => {
    const aid = areaId(req.query.area);
    const hari = Math.min(Math.max(parseInt(req.query.hari, 10) || 30, 1), 180);
    const awal = db.prepare(`SELECT date('now','localtime', ?) AS d`).get(`-${hari - 1} days`).d;
    const hariIni = db.prepare(`SELECT date('now','localtime') AS d`).get().d;

    const fArea = aid === null ? '1' : 's.area_id = @aid';
    const p = { aid, lt: LT };

    // ---------- KPI ----------
    const k = db.prepare(`
      SELECT COALESCE(SUM(s.status = 'IN' AND ${STAG} > COALESCE(bl.lead_time_hari, @lt)), 0) AS wip_lewat,
             COALESCE(SUM(date(s.tanggal_input) = date('now','localtime')), 0)             AS input_hari_ini
      FROM scan_data_new s
      LEFT JOIN Batas_Lead_Time bl ON bl.area_id = s.area_id
      WHERE ${fArea}`).get(p);
    const kpi = { hari_ini: hariIni, input_hari_ini: k.input_hari_ini, wip_lewat: k.wip_lewat };

    // ---------- daftar area (pilihan filter, selalu semua area) ----------
    const status_area = db.prepare('SELECT id AS area_id, lokasi AS area FROM Area ORDER BY id').all();

    // ---------- peta posisi per area (1 posisi = 1 gulungan) ----------
    const areaList = db.prepare(`SELECT id, lokasi FROM Area ${aid === null ? '' : 'WHERE id = @aid'} ORDER BY id`).all(p);
    const peta_posisi = areaList.map((a) => {
      const { slot } = posisi.petaArea(a);
      return {
        area_id: a.id, area: a.lokasi,
        jumlah: slot.length, terisi: slot.filter((x) => x.lots.length).length,
        slot: slot.map((x) => ({
          nomor: x.nomor, dobel: x.dobel,
          lots: x.lots.map((l) => ({
            qr_id: l.qr_id, grade: l.grade, stagnasi: l.stagnasi,
            lead_time_hari: l.lead_time_hari, status_lead: l.status_lead, urutan: l.urutan,
          })),
        })),
      };
    });

    const posisi_ringkas = peta_posisi.reduce((t, a) => ({
      total: t.total + a.jumlah, terisi: t.terisi + a.terisi,
    }), { total: 0, terisi: 0 });
    posisi_ringkas.kosong = posisi_ringkas.total - posisi_ringkas.terisi;

    // ---------- input terbaru (dari scan_log, status lot saat ini) ----------
    const input_terbaru = db.prepare(`
      SELECT l.waktu, l.qr_id, l.area, l.grade, l.posisi_wire, s.status,
             CASE WHEN s.status = 'IN' THEN ${STAG} END AS stagnasi
      FROM scan_log l
      LEFT JOIN scan_data_new s ON s.qr_id = l.qr_id
      WHERE l.aksi = 'INPUT' AND ${aid === null ? '1' : 's.area_id = @aid'}
      ORDER BY l.id DESC LIMIT 30`).all(p);

    // ---------- WIP harian ----------
    // Grafik dimulai sehari sebelum scan pertama (kalau itu lebih baru dari awal periode),
    // supaya tidak ada deretan hari nol sebelum sistem mulai dipakai.
    const pertama = db.prepare(`SELECT MIN(date(s.tanggal_input)) AS d FROM scan_data_new s WHERE ${fArea}`).get(p).d;
    const sehariSebelum = pertama ? db.prepare(`SELECT date(?, '-1 day') AS d`).get(pertama).d : hariIni;
    const awal_grafik = sehariSebelum > awal ? sehariSebelum : awal;
    const wip_harian = db.prepare(`
      WITH RECURSIVE hari(d) AS (
        SELECT @awal_grafik UNION ALL SELECT date(d, '+1 day') FROM hari WHERE d < date('now','localtime')
      )
      SELECT d AS tanggal,
             (SELECT COUNT(*) FROM scan_data_new s WHERE ${fArea}
                AND date(s.tanggal_input) <= d AND (s.tanggal_output IS NULL OR date(s.tanggal_output) > d)) AS wip,
             (SELECT COUNT(*) FROM scan_data_new s WHERE ${fArea} AND date(s.tanggal_input) = d) AS masuk,
             (SELECT COUNT(*) FROM scan_data_new s WHERE ${fArea} AND date(s.tanggal_output) = d) AS keluar
      FROM hari`).all({ aid, awal_grafik });

    res.json({
      success: true,
      data: {
        filter: { area_id: aid, hari },
        kpi, status_area, peta_posisi, posisi_ringkas, input_terbaru, wip_harian,
        waktu_server: new Date().toISOString(),
      },
    });
  });

  return router;
};
