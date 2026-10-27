/**
 * Tabel Tidak_sesuai (DBeaver) -> kolom: id, alasan_tidaksesuai, posisi_aline, posisi_v9, ...
 *   Struktur posisi sama dengan tabel POSISI: satu kolom per area (posisi_<nama area>).
 *   GET /api/tidak_sesuai -> [{ id, alasan_tidaksesuai, posisi_aline, posisi_v9, ... }]
 */
const express = require('express');

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    // kolom posisi_* dibaca dari tabel, jadi kolom area baru di DBeaver langsung ikut terkirim
    const kolom = db.prepare('PRAGMA table_info(Tidak_sesuai)').all().map((c) => c.name)
      .filter((c) => /^posisi[_ ]/i.test(c));
    const sel = ['id', 'alasan_tidaksesuai', ...kolom].map((c) => `"${c}"`).join(', ');
    res.json({ success: true, data: db.prepare(`SELECT ${sel} FROM Tidak_sesuai ORDER BY id`).all() });
  });

  return router;
};
