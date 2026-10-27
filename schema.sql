-- ============================================================
-- Struktur data SCAN di C:/sqlite/aWan_data.db (sama persis dengan yang ada di DBeaver).
-- Dijalankan server.js tiap start. Semua perintah memakai IF NOT EXISTS:
-- tabel/view/trigger yang sudah ada TIDAK diubah, hanya dibuat kalau belum ada
-- (misal pindah ke database baru).
--
-- Tabel master dikelola di DBeaver (tidak dibuat di sini, kecuali Batas_Lead_Time):
--   Area (id, lokasi), Grade (id, grade), Type (id, type_wire), POSISI (id, posisi_aline, posisi_v9, ...),
--   Alasan (id, alasan), Tidak_sesuai (id, alasan_tidaksesuai)
--
-- QR: 2026-100-10-11-0369 -> tahun 2026, mesin 100 (boleh huruf+angka, mis. A03), bulan 10, tanggal 11, no produksi 0369
-- Kolom "tahun" = TAHUN FISKAL (April - Maret), dihitung dari tanggal produksi di QR:
--   April 2026 - Maret 2027 -> 'FY26',  April 2027 - Maret 2028 -> 'FY27'
-- Tanggal input/output disimpan dengan JAM (YYYY-MM-DD HH:MM:SS); lead time & stagnasi tetap dihitung per tanggal.
-- Lead time per AREA dari tabel Batas_Lead_Time (default 4 hari).
-- batas_lead_time = tanggal_input + lead_time_hari area, dihitung di view v_main_scan & backend.
-- ============================================================

-- Batas lead time per area (hari). Ubah angkanya di DBeaver.
CREATE TABLE IF NOT EXISTS Batas_Lead_Time (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id         INTEGER NOT NULL UNIQUE REFERENCES Area(id),
    lead_time_hari  INTEGER NOT NULL DEFAULT 4 CHECK (lead_time_hari > 0)
);
-- Area baru otomatis dapat lead time 4 hari (area yang sudah ada di Batas_Lead_Time tidak diubah)
INSERT OR IGNORE INTO Batas_Lead_Time (area_id, lead_time_hari) SELECT id, 4 FROM Area;

-- Satu baris = satu gulungan wire (QR). Status IN saat di-input, OUT saat di-output.
CREATE TABLE IF NOT EXISTS scan_data_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_id           TEXT    NOT NULL UNIQUE
                    CHECK (qr_id GLOB '[0-9][0-9][0-9][0-9]-[0-9A-Z][0-9A-Z][0-9A-Z]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9]'),
    area_id         INTEGER NOT NULL REFERENCES Area(id),
    grade_id        INTEGER NOT NULL REFERENCES Grade(id),
    posisi_wire     INTEGER NOT NULL CHECK (posisi_wire > 0),
    tanggal_input   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    status          TEXT    NOT NULL DEFAULT 'IN' CHECK (status IN ('IN','OUT')),
    tanggal_output  TEXT,
    bulan       INTEGER GENERATED ALWAYS AS (CAST(substr(qr_id, 10, 2) AS INTEGER)) STORED,
    tanggal      INTEGER GENERATED ALWAYS AS (CAST(substr(qr_id, 13, 2) AS INTEGER)) STORED,
    no_produksi  TEXT    GENERATED ALWAYS AS (substr(qr_id, 16, 4))                  STORED,
    tanggal_produksi TEXT GENERATED ALWAYS AS
        (substr(qr_id, 1, 4) || '-' || substr(qr_id, 10, 2) || '-' || substr(qr_id, 13, 2)) STORED,
    alasan_id       INTEGER REFERENCES Alasan(id),
    tidak_sesuai_id INTEGER REFERENCES Tidak_sesuai(id),
    -- Tahun fiskal: bulan Jan-Mar ikut FY tahun sebelumnya. Urutan kolom sama dengan di DBeaver.
    tahun TEXT GENERATED ALWAYS AS (
        'FY' || substr(CAST(CAST(substr(qr_id, 1, 4) AS INTEGER)
                            - (CAST(substr(qr_id, 10, 2) AS INTEGER) < 4) AS TEXT), 3, 2)
        ) VIRTUAL,
    -- Lama stagnasi (hari) dari input sampai output; kosong selama masih IN
    lama_stagnasi_hari INTEGER GENERATED ALWAYS AS (
        CASE WHEN tanggal_output IS NOT NULL
             THEN CAST(julianday(date(tanggal_output)) - julianday(date(tanggal_input)) AS INTEGER)
        END) VIRTUAL,
    -- 'YA' / 'TIDAK' saat output (stagnasi > lead time area di tabel Batas_Lead_Time); diisi trigger
    lewat_lead_time TEXT,
    -- Tanggal batas lead time = tanggal_input + lead time area (tabel Batas_Lead_Time); diisi backend saat input
    tanggal_leadtime TEXT,
    -- Type wire (tabel Type di DBeaver: NORMAL / SELECTED / OFC)
    type_id         INTEGER REFERENCES Type(id),
    -- No mesin dari QR (3 karakter huruf/angka): 2026-A03-10-20-0348 -> 'A03'
    no_mesin        TEXT GENERATED ALWAYS AS (substr(qr_id, 6, 3)) VIRTUAL,
    CHECK (CAST(substr(qr_id, 10, 2) AS INTEGER) BETWEEN 1 AND 12),
    CHECK (CAST(substr(qr_id, 13, 2) AS INTEGER) BETWEEN 1 AND 31),
    CHECK ( (status = 'IN'  AND tanggal_output IS NULL)
         OR (status = 'OUT' AND tanggal_output IS NOT NULL) )
);

CREATE INDEX IF NOT EXISTS idx_scan_status        ON scan_data_new(status);
CREATE INDEX IF NOT EXISTS idx_scan_area_grade    ON scan_data_new(area_id, grade_id);
CREATE INDEX IF NOT EXISTS idx_scan_tgl_input     ON scan_data_new(tanggal_input);
CREATE INDEX IF NOT EXISTS idx_scan_tgl_output    ON scan_data_new(tanggal_output);
CREATE INDEX IF NOT EXISTS idx_scan_tgl_produksi  ON scan_data_new(tanggal_produksi);

-- lewat_lead_time dihitung dari lead time area (tabel Batas_Lead_Time) saat output / data diubah
CREATE TRIGGER IF NOT EXISTS trg_scan_lewat_lead_time
AFTER UPDATE OF status, tanggal_input, tanggal_output, area_id ON scan_data_new
BEGIN
    UPDATE scan_data_new SET lewat_lead_time =
        CASE WHEN tanggal_output IS NULL THEN NULL
             WHEN julianday(date(tanggal_output)) - julianday(date(tanggal_input))
                  > COALESCE((SELECT b.lead_time_hari FROM Batas_Lead_Time b WHERE b.area_id = scan_data_new.area_id), 4) THEN 'YA'
             ELSE 'TIDAK' END
    WHERE id = NEW.id;
END;

-- Baris yang dimasukkan langsung sebagai OUT (mis. dari DBeaver)
CREATE TRIGGER IF NOT EXISTS trg_scan_lewat_lead_time_insert
AFTER INSERT ON scan_data_new
WHEN NEW.tanggal_output IS NOT NULL
BEGIN
    UPDATE scan_data_new SET lewat_lead_time =
        CASE WHEN julianday(date(tanggal_output)) - julianday(date(tanggal_input))
                  > COALESCE((SELECT b.lead_time_hari FROM Batas_Lead_Time b WHERE b.area_id = scan_data_new.area_id), 4) THEN 'YA'
             ELSE 'TIDAK' END
    WHERE id = NEW.id;
END;

-- Riwayat setiap aksi (INPUT / OUTPUT), diisi otomatis oleh server.
-- area, grade, type wire & alasan disimpan sebagai TEKS (nama saat kejadian), supaya riwayat tetap utuh.
CREATE TABLE IF NOT EXISTS scan_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_id        TEXT NOT NULL,
    aksi         TEXT NOT NULL CHECK (aksi IN ('INPUT','OUTPUT','HAPUS')),
    area         TEXT,
    grade        TEXT,
    type_wire    TEXT,
    posisi_wire  INTEGER,
    waktu        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    alasan       TEXT,
    tidak_sesuai TEXT
);

CREATE INDEX IF NOT EXISTS idx_log_qr ON scan_log(qr_id);

-- Tabel utama ringkas untuk DBeaver: data scan + lead time area (tabel Batas_Lead_Time) + alasan
-- dibuat ulang tiap start (view tidak menyimpan data) supaya stagnasi dihitung per tanggal walau ada jam
DROP VIEW IF EXISTS v_main_scan;
CREATE VIEW v_main_scan AS
WITH base AS (
    SELECT s.*,
           COALESCE(bl.lead_time_hari, 4) AS lt,
           CAST(julianday(COALESCE(date(s.tanggal_output), date('now','localtime')))
                - julianday(date(s.tanggal_input)) AS INTEGER) AS stag_hari
    FROM scan_data_new s
    LEFT JOIN Batas_Lead_Time bl ON bl.area_id = s.area_id
)
SELECT
    b.id, b.qr_id, b.tahun, b.tanggal_produksi, b.no_produksi,
    a.lokasi AS area, g.grade AS grade, b.posisi_wire AS posisi,
    b.tanggal_input, b.status, b.tanggal_output,
    b.lt AS lead_time_hari,
    date(b.tanggal_input, '+' || b.lt || ' days') AS batas_lead_time,
    b.stag_hari AS lama_stagnasi_hari,
    CASE WHEN b.stag_hari > b.lt THEN 'YA' ELSE 'TIDAK' END AS lewat_lead_time,
    CASE
        WHEN b.status = 'IN'  AND b.stag_hari > b.lt THEN 'IN - LEWAT'
        WHEN b.status = 'IN'                         THEN 'IN - AMAN'
        WHEN b.stag_hari > b.lt                      THEN 'OUT TELAT'
        ELSE 'OUT TEPAT'
    END AS status_lead_time,
    al.alasan AS alasan, ts.alasan_tidaksesuai AS tidak_sesuai,
    b.area_id, b.grade_id, b.alasan_id, b.tidak_sesuai_id
FROM base b
LEFT JOIN Area         a  ON a.id  = b.area_id
LEFT JOIN Grade        g  ON g.id  = b.grade_id
LEFT JOIN Alasan       al ON al.id = b.alasan_id
LEFT JOIN Tidak_sesuai ts ON ts.id = b.tidak_sesuai_id;

