/**
 * Tabel POSISI (DBeaver) -> satu kolom per area: id, posisi_aline, posisi_v9, ...
 *   posisi_aline = 1..16, posisi_v9 = 1..8. Jumlah posisi bebas: tambah/hapus baris di DBeaver.
 *   Area baru cukup tambah kolom posisi_<nama area>, mis. "Area CUROD" -> posisi_curod.
 *   Area yang belum punya kolom memakai posisi 1..16 (POSISI_DEFAULT).
 *
 * Aturan: 1 posisi = 1 gulungan. Posisi "terisi" kalau ada lot berstatus IN di posisi itu.
 * Urutan ambil (FIFO) dihitung per area + grade: tanggal input paling lama = urutan 1 = "ambil".
 *
 *   GET /api/posisi?area=A-line            -> semua posisi area itu
 *   GET /api/posisi?area=A-line&kosong=1   -> hanya posisi yang masih kosong
 *     tiap posisi: { id, line, nomor, terisi, qr_id, grade, tanggal_input, stagnasi, status_lead, urutan, ambil }
 *     (id, line, nomor = format lama PosisiDto; kolom lain tambahan)
 *
 * Nama area dicocokkan longgar: "Area A-LINE", "A-line", "a line" -> kolom posisi_aline.
 * Helper diekspor untuk server.js (validasi input, posisi terisi, info FIFO) dan monitor.js (peta posisi).
 */
const express = require('express');

const POSISI_DEFAULT = 16;

// "Area A-line" / "posisi_aline" / "A Line" -> "aline"
const norm = (s) => String(s ?? '').toLowerCase().trim()
  .replace(/^area\s+/, '').replace(/^posisi[_ ]/, '').replace(/[^a-z0-9]/g, '');

module.exports = (db, { LEAD_TIME_HARI = 4 } = {}) => {
  const router = express.Router();
  const LT = Number(LEAD_TIME_HARI);

  const adaTabel = () =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'POSISI' COLLATE NOCASE").get();

  /** Nama kolom POSISI untuk area ini, atau null kalau area belum punya kolom. */
  function kolomArea(area) {
    if (!adaTabel()) return null;
    return db.prepare('PRAGMA table_info(POSISI)').all().map((c) => c.name)
      .find((c) => /^posisi[_ ]/i.test(c) && norm(c) === norm(area)) || null;
  }

  /** Nomor posisi terdaftar untuk 1 area (urut), atau null kalau area tidak punya kolom di POSISI. */
  function nomorPosisi(area) {
    const kolom = kolomArea(area);
    if (!kolom) return null;
    return db.prepare(`SELECT DISTINCT "${kolom}" AS nomor FROM POSISI WHERE "${kolom}" IS NOT NULL ORDER BY nomor`)
      .all().map((r) => r.nomor);
  }

  /** true kalau nomor posisi boleh dipakai. Area tanpa kolom di POSISI tidak dibatasi. */
  function posisiTerdaftar(area, nomor) {
    const kolom = kolomArea(area);
    if (!kolom) return true;
    return !!db.prepare(`SELECT 1 FROM POSISI WHERE "${kolom}" = ?`).get(nomor);
  }

  // Semua lot IN 1 area + urutan ambil per grade (1 = paling tua = ambil duluan)
  const lotInStmt = db.prepare(`
    SELECT s.qr_id, s.posisi_wire AS nomor, s.grade_id, g.grade, s.tanggal_input, s.tanggal_produksi,
           CAST(julianday(date('now','localtime')) - julianday(date(s.tanggal_input)) AS INTEGER) AS stagnasi,
           COALESCE(bl.lead_time_hari, ${LT}) AS lead_time_hari,
           ROW_NUMBER() OVER (PARTITION BY s.grade_id ORDER BY s.tanggal_input, s.id) AS urutan
    FROM scan_data_new s LEFT JOIN Grade g ON g.id = s.grade_id
    LEFT JOIN Batas_Lead_Time bl ON bl.area_id = s.area_id
    WHERE s.status = 'IN' AND s.area_id = ?
    ORDER BY s.posisi_wire, s.tanggal_input, s.id`);
  // lead time area (tabel Batas_Lead_Time): lewat = melebihi, hampir = hari terakhir
  const statusLead = (st, lt = LT) => (st > lt ? 'lewat' : st === lt ? 'hampir' : 'aman');

  function lotIn(areaId) {
    return lotInStmt.all(areaId).map((l) => ({ ...l, status_lead: statusLead(l.stagnasi, l.lead_time_hari), ambil: l.urutan === 1 }));
  }

  /** Lot IN per nomor posisi di 1 area -> Map(nomor -> [lot, ...]) */
  function isiPosisi(areaId) {
    const m = new Map();
    for (const l of lotIn(areaId)) {
      if (!m.has(l.nomor)) m.set(l.nomor, []);
      m.get(l.nomor).push(l);
    }
    return m;
  }

  /** Lot IN yang sedang menempati posisi ini, atau null kalau kosong. */
  const terisiStmt = db.prepare(`SELECT qr_id FROM scan_data_new WHERE status = 'IN' AND area_id = ? AND posisi_wire = ? LIMIT 1`);
  const posisiTerisi = (areaId, nomor) => terisiStmt.get(areaId, nomor) || null;

  /**
   * Info FIFO 1 lot IN: urutannya di area (semua grade, tanggal input paling lama dulu),
   * dan lot yang seharusnya diambil dulu (kalau bukan dia).
   * -> { urutan, seharusnya: { qr_id, posisi_wire, tanggal_produksi, stagnasi } | null }
   */
  function infoFifo(row) {
    if (!row || row.status !== 'IN') return null;
    const lots = lotIn(row.area_id).sort((a, b) => String(a.tanggal_input).localeCompare(String(b.tanggal_input)));
    const idx = lots.findIndex((l) => l.qr_id === row.qr_id);
    const pertama = lots[0];
    return {
      urutan: idx >= 0 ? idx + 1 : null,
      jumlah_antri: lots.length,
      seharusnya: pertama && pertama.qr_id !== row.qr_id
        ? { qr_id: pertama.qr_id, posisi_wire: pertama.nomor, tanggal_produksi: pertama.tanggal_produksi, stagnasi: pertama.stagnasi }
        : null,
    };
  }

  // ?area= bisa nama ("A-line", "Area A-LINE") atau id tabel Area
  function cariArea(input) {
    const v = String(input ?? '').trim();
    const rows = db.prepare('SELECT id, lokasi FROM Area').all();
    if (/^\d+$/.test(v)) return rows.find((r) => r.id === Number(v)) || null;
    return rows.find((r) => norm(r.lokasi) === norm(v)) || null;
  }

  /**
   * Semua posisi 1 area beserta isinya.
   * -> { terdaftar, slot: [{ nomor, terdaftar, lots: [lot...], dobel }] }
   * Lot di nomor yang tidak terdaftar tetap dimasukkan supaya tidak "hilang".
   */
  function petaArea(area) {
    const terdaftarList = nomorPosisi(area.lokasi);
    const nomor = terdaftarList || Array.from({ length: POSISI_DEFAULT }, (_, i) => i + 1);
    const isi = isiPosisi(area.id);
    const set = new Set(nomor);
    const ekstra = [...isi.keys()].filter((n) => !set.has(n)).sort((a, b) => a - b);
    const slot = [...nomor, ...ekstra].map((n) => {
      const lots = isi.get(n) || [];
      return { nomor: n, terdaftar: set.has(n), lots, dobel: lots.length > 1 };
    });
    return { terdaftar: !!terdaftarList, slot };
  }

  router.get('/', (req, res) => {
    const input = String(req.query.area ?? '').trim();
    if (!input) return res.status(400).json({ success: false, message: "Parameter 'area' wajib diisi" });
    const area = cariArea(input);
    if (!area) return res.status(404).json({ success: false, message: `Area '${input}' tidak terdaftar di tabel Area` });
    const kolom = kolomArea(area.lokasi);
    const line = kolom ? kolom.replace(/^posisi[_ ]/i, '') : norm(area.lokasi);
    let data = petaArea(area).slot.map((sl, i) => {
      // posisi dobel: tampilkan lot yang paling harus diambil
      const lot = [...sl.lots].sort((a, b) => a.urutan - b.urutan)[0];
      return {
        id: i + 1, line, nomor: sl.nomor,
        terisi: !!lot,
        dobel: sl.dobel,
        qr_id: lot ? lot.qr_id : null,
        grade: lot ? lot.grade : null,
        tanggal_input: lot ? lot.tanggal_input : null,
        stagnasi: lot ? lot.stagnasi : null,
        lead_time_hari: lot ? lot.lead_time_hari : null,
        status_lead: lot ? lot.status_lead : null,
        urutan: lot ? lot.urutan : null,
        ambil: sl.lots.some((l) => l.ambil),
      };
    });
    if (req.query.kosong === '1') data = data.filter((p) => !p.terisi);
    res.json({ success: true, data });
  });

  return { router, posisiTerdaftar, posisiTerisi, petaArea, infoFifo };
};
