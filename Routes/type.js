/**
 * Tabel Type (DBeaver) -> kolom: id, type_wire
 *   GET /api/types -> [{ id, type_wire }]   (format aplikasi Android: TypeDto)
 */
const express = require('express');

module.exports = (db) => {
  const router = express.Router();
  const semua = db.prepare('SELECT id, type_wire FROM Type ORDER BY id');

  router.get('/', (req, res) => {
    res.json({ success: true, data: semua.all() });
  });

  return router;
};
