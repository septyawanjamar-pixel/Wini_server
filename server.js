/**
 * Backend QR Scanner
 * Node.js + Express + SQLite (better-sqlite3)
 *
 * File:
 *   server.js              -> server, scan input/output, real-time, dashboard
 *   schema.sql             -> tabel scan_data_new, scan_log, view, trigger (dibuat otomatis kalau belum ada)
 *   dashboard.html         -> website monitoring (http://localhost:5111/)
 *   Routes/area.js         -> tabel Area
 *   Routes/grade.js        -> tabel Grade
 *   Routes/type.js         -> tabel Type (type wire)
 *   Routes/posisi.js       -> tabel POSISI
 *   Routes/alasan.js       -> tabel Alasan
 *   Routes/tidak_sesuai.js -> tabel Tidak_sesuai
 *   Routes/monitor.js      -> data website monitoring (KPI, peta posisi, input terbaru, WIP harian)
 *
 * Database: C:/sqlite/aWan_data.db  (file yang sama dengan DBeaver)
 *   master (DBeaver) : Area, Grade, Type, POSISI, Alasan, Tidak_sesuai, Batas_Lead_Time
 *   scan             : scan_data_new, scan_log, scan_riwayat, v_main_scan
 *
 * Jalankan di terminal Antigravity IDE (Terminal > New Terminal, folder ini):
 *   npm install      (sekali saja)
 *   npm start        (atau: node server.js)
 *   npm run dev      (server restart otomatis tiap file .js / schema.sql disimpan)
 * Ganti lokasi DB tanpa ubah kode (PowerShell):  $env:DB_PATH="D:/folder/aWan_data.db"; npm start
 *
 * Endpoint aplikasi Android (base: http://IP:5111/api/):
 *   GET  /api/areas                          -> isi tabel Area (+ lead_time_hari dari tabel Batas_Lead_Time)
 *   GET  /api/grades                         -> isi tabel Grade
 *   GET  /api/types                          -> isi tabel Type (type wire)
 *   GET  /api/posisi?area=A-line             -> posisi wire 1 area + terisi/kosong (&kosong=1 = yang kosong saja)
 *   GET  /api/alasan                         -> isi tabel Alasan
 *   GET  /api/tidak_sesuai                   -> isi tabel Tidak_sesuai (id, alasan, posisi per area seperti tabel POSISI)
 *   POST /api/scan/input   { qr_id, area, grade, type_wire, posisi_wire }
 *        1 posisi = 1 gulungan: 409 kalau posisi masih terisi lot IN (posisi_terisi: true)
 *        QR yang masih IN -> 409. QR yang sudah OUT boleh di-input lagi (area mana pun); baris lamanya
 *        dipindah ke tabel scan_riwayat, dan riwayat lengkapnya ada di scan_log.
 *   POST /api/scan/output  { qr_id, alasan, tidak_sesuai }   (alasan/tidak_sesuai: id atau nama)
 *        alasan WAJIB kalau stagnasi > lead time area (tabel Batas_Lead_Time); kalau belum lewat, alasan opsional
 *        tidak_sesuai WAJIB kalau posisi tidak sesuai FIFO (fifo.seharusnya dari backend posisi)
 *   GET  /api/scan/:qr_id                    -> detail 1 QR (+ tanggal_leadtime, lama_stagnasi_hari, lewat_lead_time,
 *                                               fifo: { urutan, seharusnya: { qr_id, posisi_wire } | null })
 *   GET  /api/scan ?area= &status=IN|OUT &tahun=FY26 &limit= &offset=
 *        tahun = tahun fiskal (April - Maret), kolom "tahun" di scan_data_new berisi 'FY26', 'FY27', ...
 *   GET  /api/events                         -> real-time (SSE), lihat di bawah
 *
 * Lain-lain:
 *   GET  /api/health                         -> cek server + database (buka di browser HP untuk tes koneksi)
 *   GET  /api/monitor ?area= &hari=30        -> data website monitoring (Routes/monitor.js)
 *   GET  /                                   -> website monitoring (dashboard.html)
 *
 * Event real-time (SSE /api/events):
 *   scan_input, scan_output -> dari aplikasi (dipakai aplikasi Android + website)
 *   lead_time_lewat         -> lot IN yang baru saja melewati lead time area-nya (dicek tiap 1 menit)
 *   db_change               -> data diubah langsung dari DBeaver (dicek tiap 2 detik)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 5111;
const HOST = '0.0.0.0';
const DB_PATH = process.env.DB_PATH || 'C:/sqlite/aWan_data.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const PAGE_PATH = path.join(__dirname, 'dashboard.html');
// Lead time diambil per area dari tabel Batas_Lead_Time. Angka ini hanya cadangan
// kalau area belum punya baris di Batas_Lead_Time.
const LEAD_TIME_HARI = 4;

// =================================================================
// 1. DATABASE
// =================================================================
let db;
try {
  // fileMustExist: jangan bikin database kosong baru kalau path-nya salah
  db = new Database(DB_PATH, { fileMustExist: true });
} catch (e) {
  console.error(`[!] Gagal membuka database ${DB_PATH}: ${e.message}`);
  console.error('    Pastikan file aWan_data.db ada, atau set DB_PATH ke lokasi yang benar.');
  process.exit(1);
}
db.pragma('journal_mode = WAL'); // aman dibaca DBeaver saat server menulis
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const hasTable = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? COLLATE NOCASE").get(name);

// Tabel master wajib dibuat dulu di DBeaver
const MASTER = ['Area', 'Grade', 'Type', 'Alasan', 'Tidak_sesuai'];
const kurang = MASTER.filter((t) => !hasTable(t));
if (kurang.length) {
  console.error(`[!] Tabel ${kurang.join(', ')} tidak ada di ${DB_PATH}. Buat dulu di DBeaver.`);
  process.exit(1);
}
if (!hasTable('POSISI')) console.warn('[!] Tabel POSISI belum ada -> posisi wire tidak dibatasi');

// Kolom tanggal_leadtime (tanggal_input + lead time area) -> ditambahkan sekali ke scan_data_new yang sudah ada
if (hasTable('scan_data_new')) {
  const kolom = db.prepare('PRAGMA table_xinfo(scan_data_new)').all().map((c) => c.name.toLowerCase());
  if (!kolom.includes('tanggal_leadtime')) {
    db.exec('ALTER TABLE scan_data_new ADD COLUMN tanggal_leadtime TEXT');
    console.log('[i] Kolom tanggal_leadtime ditambahkan ke scan_data_new');
  }
  // Kolom type_id (tabel Type) -> ditambahkan sekali ke scan_data_new yang sudah ada
  if (!kolom.includes('type_id')) {
    db.exec('ALTER TABLE scan_data_new ADD COLUMN type_id INTEGER REFERENCES Type(id)');
    console.log('[i] Kolom type_id ditambahkan ke scan_data_new');
  }
  // Kolom no_mesin dari QR: "2026-100-10-19-0601" -> "100" (otomatis terisi dari qr_id, ditambahkan sekali)
  if (!kolom.includes('no_mesin')) {
    db.exec("ALTER TABLE scan_data_new ADD COLUMN no_mesin TEXT GENERATED ALWAYS AS (substr(qr_id, 6, 3)) VIRTUAL");
    console.log('[i] Kolom no_mesin ditambahkan ke scan_data_new');
  }
  // No mesin boleh huruf + angka (mis. "100" atau "A03"): longgarkan CHECK qr_id di scan_data_new (sekali).
  // SQLite tidak bisa ubah CHECK langsung -> tabel dibuat ulang, data/index/trigger/view dipertahankan.
  const POLA_LAMA = '[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]-';
  const POLA_BARU = '[0-9][0-9][0-9][0-9]-[0-9A-Z][0-9A-Z][0-9A-Z]-';
  const sqlTabel = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scan_data_new'").get().sql;
  if (sqlTabel.includes(POLA_LAMA)) {
    const indexTrigger = db.prepare(`SELECT sql FROM sqlite_master
      WHERE tbl_name = 'scan_data_new' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all();
    const views = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view'").all();
    const kolomAsli = db.prepare('PRAGMA table_xinfo(scan_data_new)').all()
      .filter((c) => c.hidden === 0).map((c) => `"${c.name}"`).join(', '); // kolom generated tidak disalin
    const sqlBaru = sqlTabel.replace(POLA_LAMA, POLA_BARU)
      .replace(/^CREATE TABLE\s+("?)scan_data_new\1/i, 'CREATE TABLE scan_data_new_baru');
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      for (const v of views) db.exec(`DROP VIEW "${v.name}"`);
      db.exec(sqlBaru);
      db.exec(`INSERT INTO scan_data_new_baru (${kolomAsli}) SELECT ${kolomAsli} FROM scan_data_new`);
      db.exec('DROP TABLE scan_data_new');
      db.exec('ALTER TABLE scan_data_new_baru RENAME TO scan_data_new');
      for (const x of indexTrigger) db.exec(x.sql);
      for (const v of views) db.exec(v.sql);
    })();
    db.pragma('foreign_keys = ON');
    console.log('[i] scan_data_new: no mesin di qr_id sekarang boleh huruf + angka (mis. A03)');
  }
}
// Kolom type_wire di riwayat scan_log -> ditambahkan sekali ke tabel yang sudah ada
if (hasTable('scan_log')) {
  const kolomLog = db.prepare('PRAGMA table_xinfo(scan_log)').all().map((c) => c.name.toLowerCase());
  if (!kolomLog.includes('type_wire')) {
    db.exec('ALTER TABLE scan_log ADD COLUMN type_wire TEXT');
    console.log('[i] Kolom type_wire ditambahkan ke scan_log');
  }
}

// tanggal_input / tanggal_output sekarang disimpan dengan JAM (YYYY-MM-DD HH:MM:SS):
// trigger lama yang memotong jam dihapus (aman dijalankan tiap start)
db.exec('DROP TRIGGER IF EXISTS trg_scan_tanggal_insert; DROP TRIGGER IF EXISTS trg_scan_tanggal_update;');

// schema.sql hanya CREATE ... IF NOT EXISTS -> aman tiap start, tidak mengubah tabel yang sudah ada
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// Riwayat QR yang sudah OUT lalu di-input lagi (baris lama dipindah ke sini). Dibuat sekali, sama kolomnya.
db.exec('CREATE TABLE IF NOT EXISTS scan_riwayat AS SELECT * FROM scan_data_new WHERE 0');

// Isi tanggal_leadtime yang masih kosong (data lama / input dari DBeaver)
db.exec(`UPDATE scan_data_new SET tanggal_leadtime = date(tanggal_input, '+' ||
  COALESCE((SELECT b.lead_time_hari FROM Batas_Lead_Time b WHERE b.area_id = scan_data_new.area_id), ${LEAD_TIME_HARI}) || ' days')
  WHERE tanggal_leadtime IS NULL`);

// =================================================================
// 2. QR  (100-10-11-0369  ->  2026-100-10-11-0369)
// =================================================================
function normalizeQr(raw) {
  if (typeof raw !== 'string') return null;
  // no mesin 3 karakter huruf/angka, mis. "100" atau "A03"
  const full = raw.match(/(\d{4})-([0-9A-Za-z]{3})-(\d{2})-(\d{2})-(\d{4})/);
  const label = full ? null : raw.match(/([0-9A-Za-z]{3})-(\d{2})-(\d{2})-(\d{4})/);
  const qr = full ? full[0].toUpperCase() : label ? `${new Date().getFullYear()}-${label[0].toUpperCase()}` : null;
  if (!qr) return null;
  const [, , bulan, tanggal] = qr.split('-').map(Number);
  if (bulan < 1 || bulan > 12 || tanggal < 1 || tanggal > 31) return null;
  return qr;
}

// =================================================================
// 3. REAL-TIME (Server-Sent Events)
// =================================================================
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch { sseClients.delete(c); }
  }
}
// keep-alive supaya koneksi HP tidak diputus
setInterval(() => broadcast('ping', { waktu: new Date().toISOString() }), 25000).unref();

// =================================================================
// 4. EXPRESS
// =================================================================
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  console.log(`${new Date().toLocaleTimeString('id-ID')}  ${req.method} ${req.url}`);
  next();
});
app.use(express.json({ limit: '100kb' }));

const fail = (res, code, message, extra = {}) => res.status(code).json({ success: false, message, ...extra });

// ---------------- Health & events ----------------
app.get('/api/health', (req, res) => {
  let ok = false;
  try { ok = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch {}
  res.status(ok ? 200 : 500).json({
    success: ok,
    data: { server: 'ok', database: DB_PATH, db: ok ? 'ok' : 'error', waktu_server: new Date().toISOString() },
  });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': terhubung\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------------- Master (tabel DBeaver, 1 file = 1 tabel) ----------------
const posisi = require('./Routes/posisi')(db, { LEAD_TIME_HARI });
app.use('/api/areas', require('./Routes/area')(db, { LEAD_TIME_HARI }));
app.use('/api/grades', require('./Routes/grade')(db));
app.use('/api/types', require('./Routes/type')(db));
app.use('/api/posisi', posisi.router);
app.use('/api/alasan', require('./Routes/alasan')(db));
app.use('/api/tidak_sesuai', require('./Routes/tidak_sesuai')(db));

// ---------------- Scan ----------------
const FROM_SCAN = `
  FROM scan_data_new s
  LEFT JOIN Area         a  ON a.id  = s.area_id
  LEFT JOIN Grade        g  ON g.id  = s.grade_id
  LEFT JOIN Type         ty ON ty.id = s.type_id
  LEFT JOIN Alasan       al ON al.id = s.alasan_id
  LEFT JOIN Tidak_sesuai ts ON ts.id = s.tidak_sesuai_id
  LEFT JOIN Batas_Lead_Time bl ON bl.area_id = s.area_id`;

// tanggal_input/output berisi jam, tapi lama stagnasi tetap dihitung per tanggal (tanpa jam): IN -> sampai hari ini, OUT -> sampai tanggal output
const STAGNASI = `CAST(julianday(COALESCE(date(s.tanggal_output), date('now','localtime')))
                       - julianday(date(s.tanggal_input)) AS INTEGER)`;

// lead time area lot ini (tabel Batas_Lead_Time)
const LT_LOT = `COALESCE(bl.lead_time_hari, ${LEAD_TIME_HARI})`;

const SELECT_SCAN = `
  SELECT s.id, s.qr_id, s.tahun /* tahun fiskal, mis. 'FY26' */, s.bulan, s.tanggal,
         s.no_mesin, s.no_produksi, s.tanggal_produksi,
         s.area_id, a.lokasi AS area, a.lokasi AS nama_area,
         s.grade_id, g.grade,
         s.type_id, ty.type_wire,
         s.posisi_wire, s.status, s.tanggal_input, s.tanggal_leadtime, s.tanggal_output,
         s.alasan_id, al.alasan,
         s.tidak_sesuai_id, ts.alasan_tidaksesuai AS tidak_sesuai,
         ${LT_LOT} AS lead_time_hari,
         date(s.tanggal_input, '+' || ${LT_LOT} || ' days') AS batas_lead_time,
         ${STAGNASI} AS lama_stagnasi_hari,
         CASE WHEN ${STAGNASI} > ${LT_LOT} THEN 'YA' ELSE 'TIDAK' END AS lewat_lead_time
  ${FROM_SCAN}`;

const getByQr = db.prepare(`${SELECT_SCAN} WHERE s.qr_id = ?`);
const insertLog = db.prepare(
  'INSERT INTO scan_log (qr_id, aksi, area, grade, type_wire, posisi_wire, alasan, tidak_sesuai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

/** Filter GET /api/scan: ?area= (nama atau id) &status=IN|OUT &tahun=FY26 (tahun fiskal) */
function buildFilter(q) {
  const where = [], params = [];
  if (q.status === 'IN' || q.status === 'OUT') { where.push('s.status = ?'); params.push(q.status); }
  if (q.tahun) {
    // terima "FY26", "fy26", "26", atau "2026" -> 'FY26'
    const m = String(q.tahun).trim().match(/^(?:fy)?(?:20)?(\d{2})$/i);
    if (m) { where.push('s.tahun = ?'); params.push(`FY${m[1]}`); }
  }
  if (q.area) {
    const v = String(q.area).trim();
    if (/^\d+$/.test(v)) { where.push('s.area_id = ?'); params.push(Number(v)); }
    else { where.push("(a.lokasi = ? COLLATE NOCASE OR a.lokasi = 'Area ' || ? COLLATE NOCASE)"); params.push(v, v); }
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

app.get('/api/scan', (req, res) => {
  const { whereSql, params } = buildFilter(req.query);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM_SCAN} ${whereSql}`).get(...params).n;
  // ?sort=tanggal_produksi -> urut FIFO (produksi paling tua dulu); ?sort=tanggal_input -> input paling lama dulu
  const urut = req.query.sort === 'tanggal_input' ? 's.tanggal_input ASC, s.id ASC'
    : req.query.sort === 'tanggal_produksi' ? 's.tanggal_produksi ASC, s.no_produksi ASC, s.id ASC' // FIFO
    : 's.id DESC';
  const rows = db.prepare(`${SELECT_SCAN} ${whereSql} ORDER BY ${urut} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ success: true, data: rows, total, limit, offset });
});

/** Cari baris master dari id atau nama (longgar: huruf besar/kecil, spasi, garis bawah diabaikan). */
const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function cariMaster(input, sqlById, sqlAll, kolom) {
  const v = String(input ?? '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return db.prepare(sqlById).get(Number(v)) || null;
  return db.prepare(sqlAll).all().find((r) => norm(r[kolom]) === norm(v)) || null;
}
/** Area -> { id, lokasi }. Terima: 3, "Area CUROD", "CUROD". */
const resolveArea = (v) =>
  cariMaster(v, 'SELECT id, lokasi FROM Area WHERE id = ?', 'SELECT id, lokasi FROM Area', 'lokasi') ||
  db.prepare('SELECT id, lokasi FROM Area').all().find((r) => norm(r.lokasi) === norm(`Area ${v}`)) || null;
/** Grade -> { id, grade }. Terima: 2, "A", "a", "Grade A". */
const resolveGrade = (v) => cariMaster(String(v ?? '').trim().replace(/^grade\s+/i, ''),
  'SELECT id, grade FROM Grade WHERE id = ?', 'SELECT id, grade FROM Grade', 'grade');
/** Type wire -> { id, type_wire }. Terima: 1, "NORMAL", "normal". */
const resolveType = (v) => cariMaster(v,
  'SELECT id, type_wire FROM Type WHERE id = ?', 'SELECT id, type_wire FROM Type', 'type_wire');
/** Alasan -> { id, alasan }. Terima: 2, "MC_Trouble", "mc trouble". */
const resolveAlasan = (v) => cariMaster(v,
  'SELECT id, alasan FROM Alasan WHERE id = ?', 'SELECT id, alasan FROM Alasan', 'alasan');
/** Tidak sesuai -> { id, alasan_tidaksesuai }. Terima id atau nama. */
const resolveTidakSesuai = (v) => cariMaster(v,
  'SELECT id, alasan_tidaksesuai FROM Tidak_sesuai WHERE id = ?', 'SELECT id, alasan_tidaksesuai FROM Tidak_sesuai', 'alasan_tidaksesuai');

const diisi = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Kolom yang ada di scan_riwayat DAN scan_data_new -> pindah baris tetap aman walau kolom bertambah di salah satunya
const kolomRiwayat = (() => {
  const ada = new Set(db.prepare('PRAGMA table_xinfo(scan_data_new)').all().map((c) => c.name.toLowerCase()));
  return db.prepare('PRAGMA table_info(scan_riwayat)').all().map((c) => c.name)
    .filter((c) => ada.has(c.toLowerCase())).map((c) => `"${c}"`).join(', ');
})();
const pindahKeRiwayat = db.prepare(`INSERT INTO scan_riwayat (${kolomRiwayat}) SELECT ${kolomRiwayat} FROM scan_data_new WHERE id = ?`);
const hapusScan = db.prepare('DELETE FROM scan_data_new WHERE id = ?');
const insertScan = db.prepare(`INSERT INTO scan_data_new (qr_id, area_id, grade_id, type_id, posisi_wire, tanggal_input, tanggal_leadtime)
  VALUES (?, ?, ?, ?, ?, datetime('now','localtime'),
          date('now','localtime', '+' || COALESCE((SELECT lead_time_hari FROM Batas_Lead_Time WHERE area_id = ?), ${LEAD_TIME_HARI}) || ' days'))`);
const updateOutput = db.prepare(`UPDATE scan_data_new
  SET status = 'OUT', tanggal_output = datetime('now','localtime'), alasan_id = ?, tidak_sesuai_id = ?
  WHERE qr_id = ? AND status = 'IN'`);

const doInput = db.transaction((qr, area, grade, type, pos, lama) => {
  // QR yang sudah OUT di-input lagi: baris lamanya pindah ke scan_riwayat (scan_log tetap mencatat semua)
  if (lama) {
    pindahKeRiwayat.run(lama.id);
    hapusScan.run(lama.id);
  }
  // tanggal_leadtime = tanggal input + lead time area (tabel Batas_Lead_Time)
  insertScan.run(qr, area.id, grade.id, type.id, pos, area.id);
  insertLog.run(qr, 'INPUT', area.lokasi, grade.grade, type.type_wire, pos, null, null);
});

app.post('/api/scan/input', (req, res) => {
  const { qr_id, area, grade, type_wire, posisi_wire } = req.body || {};
  const qr = normalizeQr(qr_id);
  if (!qr) return fail(res, 400, 'Format QR salah');

  const areaRow = resolveArea(area);
  if (!areaRow) return fail(res, 400, `Area '${area}' tidak terdaftar di tabel Area`);
  const gradeRow = resolveGrade(grade);
  if (!gradeRow) return fail(res, 400, `Grade '${grade}' tidak terdaftar di tabel Grade`);
  const typeRow = resolveType(type_wire);
  if (!typeRow) return fail(res, 400, `Type wire '${type_wire ?? ''}' tidak terdaftar di tabel Type`);

  const pos = Number(posisi_wire);
  if (!Number.isInteger(pos) || pos <= 0) return fail(res, 400, 'Posisi wire harus angka bulat > 0');
  if (!posisi.posisiTerdaftar(areaRow.lokasi, pos)) {
    return fail(res, 400, `Posisi ${pos} tidak terdaftar untuk ${areaRow.lokasi}`);
  }

  // QR yang masih IN (belum di-output) ditolak. QR yang sudah OUT boleh di-input lagi, di area mana pun.
  const existing = getByQr.get(qr);
  if (existing && existing.status === 'IN') return fail(res, 409, 'QR sudah pernah di-input', { data: existing });

  // 1 posisi = 1 gulungan: tolak kalau posisi masih ditempati lot IN
  const penghuni = posisi.posisiTerisi(areaRow.id, pos);
  if (penghuni) {
    return fail(res, 409, `Posisi ${pos} di ${areaRow.lokasi} masih terisi ${penghuni.qr_id}. Output lot itu dulu atau pilih posisi lain.`, {
      posisi_terisi: true, data: getByQr.get(penghuni.qr_id),
    });
  }

  doInput(qr, areaRow, gradeRow, typeRow, pos, existing && existing.status === 'OUT' ? existing : null);
  const row = getByQr.get(qr);
  broadcast('scan_input', row);
  res.status(201).json({ success: true, data: row });
});

const doOutput = db.transaction((row, alasan, ts) => {
  updateOutput.run(alasan ? alasan.id : null, ts ? ts.id : null, row.qr_id);
  insertLog.run(row.qr_id, 'OUTPUT', row.area, row.grade, row.type_wire, row.posisi_wire,
    alasan ? alasan.alasan : null, ts ? ts.alasan_tidaksesuai : null);
});

app.post('/api/scan/output', (req, res) => {
  const body = req.body || {};
  const qr = normalizeQr(body.qr_id);
  if (!qr) return fail(res, 400, 'Format QR salah');
  const existing = getByQr.get(qr);
  if (!existing) return fail(res, 404, 'QR belum pernah di-input');
  if (existing.status === 'OUT') return fail(res, 409, 'QR sudah pernah di-output', { data: existing });

  // Lead time: alasan WAJIB kalau stagnasi sudah lewat lead time area-nya (tabel Batas_Lead_Time).
  // Kalau belum lewat, alasan opsional (tetap disimpan kalau diisi).
  const lewat = existing.lewat_lead_time === 'YA';
  if (lewat && !diisi(body.alasan)) {
    return fail(res, 400,
      `Lewat lead time (${existing.lama_stagnasi_hari} hari > ${existing.lead_time_hari} hari), alasan wajib diisi`,
      { perlu_alasan: true, data: existing });
  }

  let alasanRow = null, tsRow = null;
  if (diisi(body.alasan)) {
    alasanRow = resolveAlasan(body.alasan);
    if (!alasanRow) return fail(res, 400, `Alasan '${body.alasan}' tidak terdaftar di tabel Alasan`);
  }
  // Posisi tidak sesuai: lot ini bukan yang harus diambil duluan (FIFO per area dari backend posisi,
  // input paling lama dulu). Kalau tidak sesuai, alasan tidak sesuai (GRADE / SELECTED) WAJIB.
  const fifo = posisi.infoFifo(existing);
  const posisiTidakSesuai = !!(fifo && fifo.seharusnya);
  if (posisiTidakSesuai && !diisi(body.tidak_sesuai)) {
    const h = fifo.seharusnya;
    return fail(res, 400,
      `Posisi tidak sesuai: seharusnya ambil ${h.qr_id} di posisi ${h.posisi_wire}. Pilih alasan tidak sesuai`,
      { perlu_tidak_sesuai: true, data: { ...existing, fifo } });
  }
  if (posisiTidakSesuai) {
    tsRow = resolveTidakSesuai(body.tidak_sesuai);
    if (!tsRow) return fail(res, 400, `Alasan tidak sesuai '${body.tidak_sesuai}' tidak terdaftar di tabel Tidak_sesuai`);
  }

  doOutput(existing, alasanRow, tsRow);
  const row = getByQr.get(qr);
  broadcast('scan_output', row);
  res.json({ success: true, data: row });
});

app.get('/api/scan/:qr_id', (req, res) => {
  const qr = normalizeQr(req.params.qr_id) || req.params.qr_id;
  const row = getByQr.get(qr);
  if (!row) return fail(res, 404, 'Data QR tidak ditemukan');
  // fifo: urutan lot ini di area, dan lot yang seharusnya diambil dulu (null kalau sudah benar)
  res.json({ success: true, data: { ...row, fifo: posisi.infoFifo(row) } });
});

// ---------------- Website monitoring ----------------
app.use('/api/monitor', require('./Routes/monitor')(db, { LEAD_TIME_HARI, posisi }));

app.get(['/', '/index.html', '/dashboard', '/dashboard.html'], (req, res) => {
  res.sendFile(PAGE_PATH, { headers: { 'Cache-Control': 'no-store' } }, (err) => {
    if (err && !res.headersSent) fail(res, 404, 'dashboard.html tidak ditemukan di folder server');
  });
});

// ---------------- 404 & error ----------------
app.use((req, res) => fail(res, 404, `Endpoint ${req.method} ${req.path} tidak ada`));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'JSON tidak valid');
  console.error(err);
  fail(res, 500, err.message || 'kesalahan server');
});

// =================================================================
// 5. PEMANTAU REAL-TIME (untuk website monitoring)
// =================================================================
// a) Perubahan dari DBeaver. PRAGMA data_version hanya berubah kalau KONEKSI LAIN
//    (DBeaver) menyimpan data, jadi tulisan server sendiri tidak memicu event ini.
let versiDb = db.pragma('data_version', { simple: true });
setInterval(() => {
  try {
    const v = db.pragma('data_version', { simple: true });
    if (v !== versiDb) {
      versiDb = v;
      console.log(`${new Date().toLocaleTimeString('id-ID')}  [db_change] data diubah dari DBeaver`);
      broadcast('db_change', { sumber: 'dbeaver', waktu: new Date().toISOString() });
    }
  } catch (e) { console.error('[!] cek data_version:', e.message); }
}, 2000).unref();

// b) Lot IN yang baru melewati lead time. Saat server start, yang sudah lewat dicatat dulu
//    (tidak dikirim ulang). Dicek tiap 1 menit, jadi pergantian hari ikut terdeteksi.
const sudahDikabari = new Set();
const cariLewat = db.prepare(`${SELECT_SCAN} WHERE s.status = 'IN' AND ${STAGNASI} > ${LT_LOT}`);
function cekLeadTime(kirim) {
  try {
    const sekarang = new Set();
    for (const row of cariLewat.all()) {
      sekarang.add(row.qr_id);
      if (sudahDikabari.has(row.qr_id)) continue;
      sudahDikabari.add(row.qr_id);
      if (kirim) {
        console.log(`${new Date().toLocaleTimeString('id-ID')}  [lead_time_lewat] ${row.qr_id} (${row.area}, ${row.lama_stagnasi_hari} hari)`);
        broadcast('lead_time_lewat', row);
      }
    }
    for (const qr of sudahDikabari) if (!sekarang.has(qr)) sudahDikabari.delete(qr); // sudah OUT / dihapus
  } catch (e) { console.error('[!] cek lead time:', e.message); }
}
cekLeadTime(false);
setInterval(() => cekLeadTime(true), 60000).unref();

// =================================================================
// 6. JALANKAN SERVER
// =================================================================
const server = app.listen(PORT, HOST, () => {
  console.log(`Server jalan di port ${PORT}`);
  console.log(`Database : ${DB_PATH}  (sama dengan DBeaver)`);
  console.log(`Dashboard di PC ini : http://localhost:${PORT}/`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`Untuk HP asli (satu WiFi): http://${n.address}:${PORT}/`);
    }
  }
  console.log(`Emulator Android Studio memakai: http://10.0.2.2:${PORT}/`);
  console.log('Tekan Ctrl + C untuk menghentikan server.');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[!] Port ${PORT} sudah dipakai program lain (mungkin server lama masih jalan).`);
    process.exit(1);
  }
  throw e;
});

const shutdown = () => {
  console.log('\nMenutup server...');
  server.close();
  try { db.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
