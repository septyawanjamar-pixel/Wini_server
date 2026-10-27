/**
 * Tabel Alasan (DBeaver) -> kolom: id, alasan
 *   GET /api/alasan -> [{ id, alasan }]   (dropdown alasan di layar OUTPUT)
 */
const express = require('express');

module.exports = (db) => {
  const router = express.Router();
  const semua = db.prepare('SELECT id, alasan FROM Alasan ORDER BY id');

  router.get('/', (req, res) => res.json({ success: true, data: semua.all() }));

  return router;
};
