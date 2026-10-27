/**
 * Tabel Area (DBeaver) -> kolom: id, lokasi   (+ lead time dari tabel Batas_Lead_Time)
 *   GET /api/areas -> [{ id, kode_area, nama_area, aktif, lead_time_hari }]   (format aplikasi Android: AreaDto)
 */
const express = require('express');

module.exports = (db, { LEAD_TIME_HARI = 4 } = {}) => {
  const router = express.Router();
  const semua = db.prepare(`
    SELECT a.id, a.lokasi, COALESCE(l.lead_time_hari, ${Number(LEAD_TIME_HARI)}) AS lead_time_hari
    FROM Area a LEFT JOIN Batas_Lead_Time l ON l.area_id = a.id
    ORDER BY a.id`);

  router.get('/', (req, res) => {
    const data = semua.all().map((r) => ({
      id: r.id, kode_area: r.lokasi, nama_area: r.lokasi, aktif: 1, lead_time_hari: r.lead_time_hari,
    }));
    res.json({ success: true, data });
  });

  return router;
};
