-- Pantaw initial schema
-- Lihat docs/design/rfc.md section 4.3

-- Systems: server yang dimonitor
CREATE TABLE systems (
  id              TEXT PRIMARY KEY,        -- nanoid atau uuid
  name            TEXT NOT NULL UNIQUE,
  host            TEXT NOT NULL,           -- hostname/IP agent (informational)
  agent_token_hash TEXT NOT NULL,          -- SHA-256 dari API key
  timeout_seconds INTEGER NOT NULL DEFAULT 90,
  last_status     TEXT NOT NULL DEFAULT 'unknown', -- snapshot status terakhir hasil cron (up|down|unknown)
  last_status_at  INTEGER,                 -- unix ts saat last_status diset cron
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  info            TEXT                     -- JSON: OS, kernel, uptime, dll
);

-- Users: akun yang bisa login ke dashboard
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,           -- PHC string: $pbkdf2-sha256$i=...$salt$hash
  role            TEXT NOT NULL DEFAULT 'user', -- admin | user
  created_at      INTEGER NOT NULL,
  system_ids      TEXT NOT NULL DEFAULT '[]' -- JSON array: system ID yang boleh diakses
);

-- Metrics: time-series data dari agent (hot path tabel)
-- WITHOUT ROWID + composite PK untuk hemat write overhead dan storage.
-- Lihat RFC section 4.3 catatan desain di tabel metrics.
CREATE TABLE metrics (
  system_id  TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,             -- unix timestamp, resolusi 30 detik
  cpu        REAL,                         -- persen (0-100)
  mem        REAL,                         -- persen (0-100)
  mem_used   INTEGER,                      -- bytes
  mem_total  INTEGER,                      -- bytes
  disk       REAL,                         -- persen (0-100)
  disk_read  INTEGER,                      -- bytes/s
  disk_write INTEGER,                      -- bytes/s
  net_rx     INTEGER,                      -- bytes/s
  net_tx     INTEGER,                      -- bytes/s
  load1      REAL,
  load5      REAL,
  load15     REAL,
  temp       REAL,                         -- celsius, nullable
  extra      TEXT,                         -- JSON: GPU, container stats, dll
  PRIMARY KEY (system_id, ts)              -- juga menjamin idempotensi ingest retry
) WITHOUT ROWID;

-- Alerts: konfigurasi threshold per system
CREATE TABLE alerts (
  id           TEXT PRIMARY KEY,
  system_id    TEXT REFERENCES systems(id) ON DELETE CASCADE,
  metric       TEXT NOT NULL,              -- cpu | mem | disk | status | temp
  threshold    REAL NOT NULL,              -- nilai ambang batas
  operator     TEXT NOT NULL,              -- gt | lt | eq
  duration_s   INTEGER NOT NULL DEFAULT 60, -- harus terpenuhi selama N detik
  enabled      INTEGER NOT NULL DEFAULT 1, -- boolean (0|1)
  webhook_url  TEXT,                       -- URL notifikasi (Telegram, Slack, dll)
  last_fired   INTEGER                     -- unix timestamp terakhir alert dikirim
);

CREATE INDEX idx_alerts_system ON alerts (system_id);

-- Agent tokens: API key per system untuk auth ingest
CREATE TABLE agent_tokens (
  id          TEXT PRIMARY KEY,
  system_id   TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 dari token mentah
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);

CREATE INDEX idx_agent_tokens_system ON agent_tokens (system_id);
