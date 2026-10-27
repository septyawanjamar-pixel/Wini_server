/**
 * Tabel Grade (DBeaver) -> kolom: id, grade
 *   GET /api/grades -> [{ id, grade, keterangan }]   (format aplikasi Android: GradeDto)
 */
const express = require('express');

module.exports = (db) => {
  const router = express.Router();
  const semua = db.prepare('SELECT id, grade FROM Grade ORDER BY id');

  router.get('/', (req, res) => {
    const data = semua.all().map((r) => ({ id: r.id, grade: r.grade, keterangan: `Grade ${r.grade}` }));
    res.json({ success: true, data });
  });

  return router;
};
