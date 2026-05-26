# RFC: Pantaw

**Status:** Draft  
**Tanggal:** 2026-05-26  
**Penulis:** -  
**Inspirasi:** https://github.com/henrygd/beszel  

---

## 1. Ringkasan

RFC ini mengusulkan **Pantaw** — platform monitoring server ringan yang berjalan sepenuhnya di atas **Cloudflare free tier** tanpa memerlukan VPS atau server tersendiri. Pantaw terinspirasi dari [Beszel](https://github.com/henrygd/beszel) dan mengadopsi pendekatan agent-hub yang serupa, tetapi diimplementasikan ulang untuk runtime edge.

Nama "Pantaw" diambil dari kata "pantau" (Bahasa Indonesia: memantau / memonitor).

**Catatan kompatibilitas:** Pantaw bukan fork drop-in dari Beszel. Wire protocol agent→hub berbeda (HTTPS POST vs SSH tunnel) dan skema data tidak identik. Agent Pantaw adalah implementasi independen yang terinspirasi dari arsitektur Beszel agent.

---

## 2. Latar Belakang & Motivasi

Beszel hub berjalan di atas **PocketBase** — sebuah binary Go yang membutuhkan:

- Filesystem persisten untuk database SQLite
- Long-running process (tidak bisa di-terminate antar request)
- TCP server untuk menerima koneksi SSH dari agent

Ketiga kebutuhan ini tidak kompatibel dengan model eksekusi Cloudflare Workers (stateless, ephemeral, request-response). Akibatnya, menjalankan hub Beszel gratis mengharuskan pengguna memiliki VPS atau server sendiri.

Pantaw mengambil pendekatan berbeda: arsitektur dirancang ulang dari awal untuk runtime edge, sehingga bisa berjalan di Cloudflare free tier tanpa kompromi pada experience pengguna.

**Tujuan RFC ini:**

1. Merancang arsitektur Pantaw yang sepenuhnya berjalan di Cloudflare free tier
2. Mempertahankan kompatibilitas konseptual dengan model agent-hub Beszel (memudahkan onboarding bagi pengguna Beszel)
3. Mendokumentasikan trade-off, batasan, dan keputusan desain

---

## 3. Perubahan Arsitektur

### 3.1 Arsitektur Referensi (Beszel)

```
Agent (di setiap server)
  └─── SSH reverse tunnel ──→ Hub (PocketBase + SQLite, VPS)
                                    └─── HTTP ──→ Browser (dashboard)
```

- Agent membuka SSH tunnel ke hub
- Hub menerima metrik melalui tunnel
- Hub menyajikan dashboard via web server PocketBase
- SQLite file disimpan di disk VPS

### 3.2 Arsitektur Pantaw

```
Agent (di setiap server)
  └─── HTTPS POST /api/v1/ingest ──→ Cloudflare Worker (Hono + Static Assets)
                                              ├─── D1 (penyimpanan metrik)
                                              ├─── KV (session, rate-limit, latest-metrics cache)
                                              └─── Static Assets (SPA bundle) → Browser

Worker Cron Trigger (alert + status checker, tiap 2 menit)
```

Server (Hono) dan SPA (React) di-bundle dalam **satu Vite project** dan di-deploy sebagai **satu Worker** dengan Workers Static Assets. Tidak ada deployment terpisah, tidak ada CORS, dan client memanggil API via Hono RPC client untuk type-safety end-to-end.

**Perubahan dari arsitektur referensi:**

| Komponen | Beszel | Pantaw |
|---|---|---|
| Transport agent→hub | SSH reverse tunnel | HTTPS POST |
| Runtime hub | Go binary (PocketBase) | Cloudflare Worker (TypeScript + Hono) |
| Database | SQLite (file di disk) | D1 (SQLite-compatible) |
| State management | In-memory PocketBase | Stateless Workers + D1 (status dihitung dari `MAX(metrics.ts)`) |
| Auth | PocketBase built-in | JWT (HS256) + API Key, diverifikasi di Worker |
| Dashboard UI | React SPA di-embed di binary Go | React SPA di Workers Static Assets (1 Worker dengan API) |
| Client-server contract | PocketBase JS SDK + realtime | Hono RPC (type-safe) + polling via TanStack Query |
| Alert scheduler | PocketBase hooks | Worker Cron Trigger |
| Hosting | VPS (berbayar) | Cloudflare free tier |

**Catatan desain:** Versi awal RFC ini sempat memasukkan Durable Objects untuk per-agent state, buffer metrik, dan deteksi agent down via DO Alarms. Setelah dihitung ulang, kombinasi ingest + alarm DO untuk 10 agent menghasilkan ~1,3 juta DO invocation/bulan, sudah melampaui DO free tier (1M/bulan), padahal manfaatnya bisa dicapai cukup dengan kolom `last_seen` di D1 atau perhitungan dinamis dari `MAX(metrics.ts)`. Karena MVP juga tidak membutuhkan WebSocket fan-out (lihat section 11 #3), DO didrop dari arsitektur. Dapat ditambahkan kembali di fase berikutnya bila real-time push diperlukan.

---

## 4. Spesifikasi Komponen

**Project structure:** Hub Pantaw adalah satu Vite project yang berisi server (Hono Worker) dan SPA (React) dalam satu codebase, di-deploy sebagai satu Cloudflare Worker dengan Workers Static Assets. Layout direktori (lihat 4.0):

```
pantaw/
├── wrangler.toml
├── vite.config.ts
├── package.json
├── migrations/                    # Wrangler D1 migrations (lihat 4.6)
├── src/
│   ├── server/                    # Hono Worker (lihat 4.1)
│   │   ├── index.ts              # app instance + export type AppType
│   │   ├── routes/                # ingest.ts, auth.ts, systems.ts, alerts.ts
│   │   ├── middleware/            # auth.ts, rate-limit.ts
│   │   ├── lib/                   # db.ts, password.ts, jwt.ts
│   │   └── cron.ts                # scheduled handler
│   ├── client/                    # SPA React (lihat 4.7)
│   │   ├── main.tsx
│   │   ├── components/
│   │   └── lib/api.ts             # hc<AppType> Hono RPC client
│   └── shared/                    # tipe & schema dipakai dua sisi
│       ├── types.ts
│       └── schemas.ts             # Valibot schemas
└── tests/
```

**Disiplin separation:** Client tidak boleh `import` dari `src/server/*`, dan sebaliknya. Tipe & schema bersama hanya melalui `src/shared/*`. ESLint rule `no-restricted-imports` enforce ini.

### 4.1 Server (Hono Worker)

Ditulis dalam TypeScript dengan **Hono** sebagai HTTP framework. Hono native untuk runtime Workers (~14KB), middleware-friendly, dan punya RPC client yang memberi type-safety end-to-end.

**Endpoints:**

| Method | Path | Deskripsi |
|---|---|---|
| `POST` | `/api/v1/ingest` | Agent mengirim metrik (auth: API key) |
| `GET` | `/api/v1/systems` | Daftar semua system (auth: JWT) |
| `GET` | `/api/v1/systems/:id/metrics` | Metrik historis satu system (auth: JWT) |
| `POST` | `/api/v1/auth/login` | Login user, kembalikan JWT |
| `POST` | `/api/v1/systems` | Tambah system baru (auth: JWT, admin) |
| `DELETE` | `/api/v1/systems/:id` | Hapus system (auth: JWT, admin) |
| `GET` | `/api/v1/alerts` | Daftar alert aktif |
| `PUT` | `/api/v1/alerts/:id` | Update konfigurasi alert |

**Validasi request:** Semua endpoint pakai `@hono/valibot-validator` dengan schema dari `src/shared/schemas.ts`. Schema yang sama dipakai di SPA untuk validasi form, sehingga tidak ada duplikasi rule.

**Type-safe client:** Server export `type AppType = typeof app`. SPA import tipe ini via `hc<AppType>("/")` dari `hono/client` untuk autocomplete + type-check pada request body, query param, dan response shape.

**Autentikasi dua lapis:**

- **Agent → Hub:** API key stateless, dikirim sebagai header `Authorization: Bearer <key>`. Key di-hash (SHA-256) dan disimpan di D1 table `agent_tokens`.
- **User → Hub:** Username + password → JWT (HS256 dengan claim `kid`, expire 24 jam, lihat 8.3). JWT disimpan di cookie HttpOnly + SameSite=Strict, di-verify di Worker tanpa DB lookup per-request. Refresh token disimpan di KV dengan TTL 30 hari.

### 4.2 Status & Liveness Tracking (Stateless)

MVP tidak menggunakan Durable Objects. Status agent (`up` / `down` / `unknown`) tidak disimpan sebagai kolom stored, melainkan dihitung dari timestamp metrik terakhir:

```
status = up      jika now - MAX(metrics.ts) < timeout_seconds
status = down    jika now - MAX(metrics.ts) >= timeout_seconds
status = unknown jika belum pernah ada metrik untuk system tsb
```

Default `timeout_seconds` = 90 (3× interval polling 30 detik).

**Alur ingest:**

```
POST /api/v1/ingest
  1. Verify Bearer token → resolve system_id
  2. Validate payload (schema, ts dalam window wajar)
  3. INSERT OR IGNORE INTO metrics (system_id, ts, ...)  -- idempotent via PK (system_id, ts)
  4. Update CACHE_KV: metrics:{system_id}:latest = payload (TTL 90s)
  5. Update agent_tokens.last_used (best-effort, boleh di-skip jika hot path)
  6. Return 204
```

Ingest hanya melakukan **1 D1 write** ke tabel `metrics`. Tabel `systems` tidak di-update per-ingest sehingga write D1 tidak berlipat ganda.

**Deteksi agent down:** dilakukan oleh cron trigger (lihat 4.5) yang menscan systems dan membandingkan `MAX(metrics.ts)` dengan `now - timeout_seconds`. Jika transition `up → down`, kirim webhook dan log ke `alerts.last_fired`.

**Idempotensi:** `metrics` menggunakan PK composite `(system_id, ts)`. Jika agent retry POST yang sudah berhasil tertulis, `INSERT OR IGNORE` mengabaikan duplikat tanpa error.

### 4.3 Database Schema

Database: **Cloudflare D1** (SQLite-compatible).

#### Tabel `systems`

```sql
CREATE TABLE systems (
  id          TEXT PRIMARY KEY,        -- nanoid atau uuid
  name        TEXT NOT NULL UNIQUE,
  host        TEXT NOT NULL,           -- hostname/IP agent (informational)
  agent_token_hash TEXT NOT NULL,      -- SHA-256 dari API key
  timeout_seconds INTEGER DEFAULT 90,  -- ambang batas down detection
  last_status TEXT DEFAULT 'unknown',  -- snapshot status terakhir hasil cron (up|down|unknown)
  last_status_at INTEGER,              -- unix ts saat last_status diset cron
  created_at  INTEGER NOT NULL,        -- unix timestamp
  updated_at  INTEGER NOT NULL,
  info        TEXT                     -- JSON: OS, kernel, uptime, dll
);

-- Catatan: status real-time dihitung dari MAX(metrics.ts).
-- last_status hanya snapshot dari cron untuk keperluan alert state machine
-- (mendeteksi transition up<->down) dan dashboard fallback saat KV miss.
```

#### Tabel `users`

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,         -- PHC string: $pbkdf2-sha256$i=...$salt$hash
  role         TEXT DEFAULT 'user',    -- admin | user
  created_at   INTEGER NOT NULL,
  system_ids   TEXT DEFAULT '[]'       -- JSON array: system ID yang boleh diakses
);
```

#### Tabel `metrics`

```sql
CREATE TABLE metrics (
  system_id  TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,         -- unix timestamp, resolusi 30 detik
  cpu        REAL,                     -- persen (0-100)
  mem        REAL,                     -- persen (0-100)
  mem_used   INTEGER,                  -- bytes
  mem_total  INTEGER,                  -- bytes
  disk       REAL,                     -- persen (0-100)
  disk_read  INTEGER,                  -- bytes/s
  disk_write INTEGER,                  -- bytes/s
  net_rx     INTEGER,                  -- bytes/s
  net_tx     INTEGER,                  -- bytes/s
  load1      REAL,
  load5      REAL,
  load15     REAL,
  temp       REAL,                     -- celsius, nullable
  extra      TEXT,                     -- JSON: GPU, container stats, dll
  PRIMARY KEY (system_id, ts)          -- juga menjamin idempotensi ingest retry
) WITHOUT ROWID;

-- Catatan desain:
-- 1. Tidak ada kolom `id` surrogate. PK composite (system_id, ts) sudah
--    cukup untuk semua query path (ingest, dashboard, cron status).
-- 2. WITHOUT ROWID menyimpan data langsung di PK btree, tidak ada rowid
--    btree terpisah. Hemat ~30–40% storage dan 1 btree write per insert.
-- 3. Tidak perlu CREATE INDEX (system_id, ts DESC) karena SQLite scan
--    backward over PK btree untuk ORDER BY ts DESC tanpa penalty.
-- 4. INSERT OR IGNORE menggunakan konflik PK untuk idempotensi retry.
```

#### Tabel `alerts`

```sql
CREATE TABLE alerts (
  id           TEXT PRIMARY KEY,
  system_id    TEXT REFERENCES systems(id) ON DELETE CASCADE,
  metric       TEXT NOT NULL,          -- cpu | mem | disk | status | temp
  threshold    REAL NOT NULL,          -- nilai ambang batas
  operator     TEXT NOT NULL,          -- gt | lt | eq
  duration_s   INTEGER DEFAULT 60,     -- harus terpenuhi selama N detik
  enabled      INTEGER DEFAULT 1,      -- boolean
  webhook_url  TEXT,                   -- URL notifikasi (Telegram, Slack, dll)
  last_fired   INTEGER                 -- unix timestamp terakhir alert dikirim
);
```

#### Tabel `agent_tokens`

```sql
CREATE TABLE agent_tokens (
  id          TEXT PRIMARY KEY,
  system_id   TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,    -- SHA-256 dari token mentah
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
```

**Strategi retensi data:** Metrik dihapus secara otomatis oleh cron trigger berdasarkan konfigurasi `RETENTION_DAYS` (default: 30 hari).

### 4.4 KV Namespaces & Bindings

| Namespace | Key | Value | TTL |
|---|---|---|---|
| `SESSION_KV` | `session:{user_id}:{jti}` | JSON user info | 30 hari |
| `RATE_KV` | `login:{email}` | Counter JSON | 15 menit |
| `CACHE_KV` | `metrics:{system_id}:latest` | JSON metrik terakhir | 90 detik |

`RATE_KV` sekarang hanya dipakai untuk login throttling (volume rendah, muat di kuota KV writes). Rate limiting `/ingest` tidak pakai KV karena volume tinggi (28.800/hari) akan melampaui 1000 KV writes/hari free tier.

**Workers Rate Limiting binding** (di luar KV):

| Binding | Limit | Period | Key |
|---|---|---|---|
| `INGEST_LIMITER` | 3 request | 60 detik | `tokenHash` (per-token, bukan per-IP) |

Binding ini native Cloudflare, free tier dengan limit operasi yang generous, tidak makan kuota KV. Kunci per-token mencegah bypass via IP rotation dan tidak salah-blokir banyak agent di belakang NAT yang sama.

Cache KV untuk metrik terakhir penting: setiap kali dashboard di-poll, Workers membaca dari KV (sub-ms) bukan dari D1, menghemat rows read secara signifikan.

### 4.5 Cron Triggers

| Trigger | Schedule | Fungsi |
|---|---|---|
| Alert + status checker | `*/2 * * * *` | Untuk tiap system: hitung status dari `MAX(metrics.ts)`, deteksi transition up↔down, evaluasi threshold alert (cpu/mem/disk/temp), kirim webhook jika perlu, update `systems.last_status` jika berubah |
| Metrics cleanup | `0 2 * * *` | Hapus metrik lebih lama dari `RETENTION_DAYS` |

Semua kebutuhan periodic dikonsolidasi ke satu cron `*/2 * * * *` agar invocation Workers cron tetap minimal (~720/hari) dan logic state-transition alert tidak race dengan status sync.

### 4.6 Schema Migrations

Schema D1 dikelola via **Wrangler migrations** (`wrangler d1 migrations`). Struktur direktori:

```
migrations/
  0001_initial.sql           # CREATE semua tabel awal
  0002_<deskripsi>.sql       # ALTER atau CREATE tambahan
  ...
```

Apply lokal (untuk development): `wrangler d1 migrations apply pantaw --local`  
Apply production: `wrangler d1 migrations apply pantaw --remote`

Wrangler maintain tabel `d1_migrations` otomatis untuk track migration yang sudah applied. File migrasi diberi nama dengan prefix nomor urut dan dijalankan sekali (idempotent at the migration level).

**Catatan keterbatasan SQLite/D1 untuk DDL:**

- `ALTER TABLE ADD COLUMN` didukung
- `ALTER TABLE DROP COLUMN` didukung di SQLite ≥3.35 (D1 sudah support)
- Perubahan kompleks (rename column dengan constraint baru, ubah tipe kolom) butuh pattern: create new table → copy data → drop old → rename. Migrasi forward-only, tidak ada rollback otomatis
- **Backup sebelum migrasi destructive:** `wrangler d1 export pantaw --output backup.sql`

### 4.7 SPA Dashboard (React + Vite)

UI Pantaw di-fork dari [Beszel UI](https://github.com/henrygd/beszel/tree/main/internal/site) (MIT-licensed) sebagai starting point. Lapisan data fetching (PocketBase SDK + realtime) di-replace dengan Hono RPC client + polling. Visual design, charts, tables, dan struktur komponen dipertahankan untuk menghemat effort.

**Stack (mirror Beszel kecuali bagian transport ke server):**

| Aspek | Pilihan |
|---|---|
| Framework | React 19 + Vite |
| Bahasa | TypeScript |
| Styling | Tailwind CSS 4 |
| Component primitive | Radix UI |
| UI pattern | shadcn/ui (komponen di-copy ke `src/client/components/ui/`) |
| Charts | Recharts |
| Tables | TanStack Table + TanStack Virtual |
| Icons | lucide-react |
| Validation | Valibot (shared dengan server via `src/shared/schemas.ts`) |
| State (client) | Nanostores (mengikuti Beszel) |
| Routing | nanostores/router (mengikuti Beszel) |
| Data fetching | TanStack Query + Hono RPC client (`hc<AppType>`) |
| i18n | Lingui |
| Linter/formatter | Biome |
| Package manager | Bun |

**Fitur Beszel yang di-drop di MVP Pantaw** (untuk fokus + sesuai scope hub baru):

- SMART disk monitoring (butuh agent collector tambahan)
- Systemd table (butuh agent collector tambahan)
- OAuth providers, OTP, fingerprint tokens (auth Pantaw cukup password + JWT)
- Public key copy / SSH-based auth
- Notifications config kompleks (cukup webhook URL per alert di MVP)

**Fitur MVP yang dipertahankan/ditambahkan:**

- Login page
- Dashboard: daftar semua system dengan status (polling 30s ke `CACHE_KV`)
- System detail: grafik CPU, memory, disk, network (time range: 1j, 6j, 24j, 7d)
- Alert management: buat dan edit alert threshold
- Settings: tambah/hapus system, generate API key, manage user (single admin di MVP)
- Theme: dark mode default + light mode
- i18n: English + Bahasa Indonesia (locale lain dari Beszel di-keep namun tidak di-translate aktif)

**Realtime → polling:** Pemanggilan `pb.collection(...).subscribe(...)` di Beszel UI digantikan dengan TanStack Query `useQuery({ refetchInterval: 30000 })`. Indicator "last updated X seconds ago" ditampilkan untuk transparansi.

**Auth di SPA:** JWT disimpan di cookie HttpOnly (di-set oleh server saat login), bukan di `localStorage`. Browser otomatis kirim cookie pada same-origin request, tidak perlu manual `Authorization` header. SameSite=Strict cukup untuk CSRF protection di setup self-hosted single-admin.

**Atribusi:** README dan `NOTICE` mengkredit Beszel + henrygd. License MIT asli dipertahankan untuk file yang di-copy.

---

## 5. Agent

Pantaw membutuhkan agent yang berjalan di tiap server target untuk mengumpulkan metrik dan mengirimkannya ke hub via HTTPS POST. Untuk MVP, agent ditulis sebagai binary Go terpisah dengan footprint minimal (mirip Beszel agent dalam semangat dan ukuran).

**Karakteristik agent:**

```
Loop setiap INTERVAL detik (default 30):
  1. Kumpulkan metrik (CPU, mem, disk, net, load, temp)
  2. Optional: kumpulkan container stats (Docker)
  3. Serialize ke JSON (lihat section 6)
  4. HTTPS POST ke {HUB_URL}/api/v1/ingest
     Header: Authorization: Bearer {AGENT_TOKEN}
  5. Tangani response sesuai status code (lihat di bawah)
```

**Status code handling:**

| Status | Tindakan agent |
|---|---|
| 2xx | Sukses, lanjut interval berikutnya |
| 4xx (kecuali 429) | Log error, drop sample. Kemungkinan token invalid, payload malformed, atau clock skew. Tidak retry. |
| 429 | Honor `Retry-After` header. Tidak eskalasi ke alert. |
| 5xx atau network error | Retry dengan exponential backoff: 5s, 15s, 60s, 5m. Setelah 5m, drop sample dan kembali ke loop normal. |

**Catatan kesederhanaan:** MVP tidak menggunakan persistent buffer/ring buffer. Saat hub down lebih dari 5 menit, sample selama outage hilang. Karena `metrics.PRIMARY KEY (system_id, ts)` menjamin idempotensi, durable buffering bisa ditambahkan post-MVP tanpa perubahan server-side.

**Clock skew:** Server menolak payload dengan `ts` di luar jendela `[now - 5min, now + 1min]` (HTTP 400). Agent harus sinkronisasi clock via NTP sebelum start.

**Konfigurasi agent:**

```env
HUB_URL=https://your-hub.workers.dev
AGENT_TOKEN=<api-key-dari-dashboard>
INTERVAL=30             # detik
```

**Catatan tentang Beszel agent:** Karena wire protocol Pantaw (HTTPS POST) berbeda dari Beszel (SSH tunnel), Beszel agent tidak bisa langsung digunakan. Pengguna existing Beszel yang ingin mencoba Pantaw perlu mengganti binary agent. Tool migrasi dari PocketBase ke D1 di-defer ke post-MVP (lihat section 11).

---

## 6. Payload Ingestion

Agent mengirim metrik dalam format JSON berikut setiap interval. Endpoint accept **single object** (default) atau **array of objects** (untuk batching post-MVP):

```json
{
  "ts": 1716700000,
  "cpu": 23.4,
  "mem": 61.2,
  "mem_used": 4194304000,
  "mem_total": 8388608000,
  "disk": 45.0,
  "disk_read": 204800,
  "disk_write": 81920,
  "net_rx": 1048576,
  "net_tx": 524288,
  "load": [1.2, 0.9, 0.7],
  "temp": 52.3,
  "uptime": 864000,
  "containers": [
    {
      "name": "nginx",
      "cpu": 0.8,
      "mem": 52428800,
      "net_rx": 10240,
      "net_tx": 4096
    }
  ]
}
```

**Validasi server-side:**

- `ts` harus dalam jendela `[now - 5min, now + 1min]` (mencegah clock skew + replay)
- Tipe data sesuai schema `metrics`
- Ukuran payload ≤ 64KB (cukup untuk ≈1000 container)

Workers memvalidasi payload ini, mengekstrak `system_id` dari token, lalu menulis 1 row ke `metrics` (D1) dan menyegarkan `CACHE_KV: metrics:{system_id}:latest`. Tidak ada state lain yang diupdate per-ingest; status agent dihitung secara dinamis dari `MAX(metrics.ts)` (lihat 4.2).

---

## 7. Kalkulasi Free Tier

Asumsi: **10 server**, polling interval **30 detik**, **20 dashboard page load/hari**.

| Sumber | Request/hari | Kuota Free | Persentase |
|---|---|---|---|
| Workers (agent ingest) | 28.800 | 100.000/hari | 29% |
| Workers (dashboard API) | 100 | 100.000/hari | <1% |
| Workers (cron alert+status) | 720 | 100.000/hari | <1% |
| **Workers total** | **~29.620** | **100.000** | **~30%** |

| Sumber | Rows/hari | Kuota D1 Free | Persentase |
|---|---|---|---|
| D1 writes (ingest, 1 row/payload) | 28.800 | 100K/hari | ~29% |
| D1 reads (auth lookup agent_tokens) | 28.800 | 5M/hari | <1% |
| D1 reads (cron alert+status, ~720 × N system) | ~7.200 | 5M/hari | <1% |
| D1 reads (dashboard) | ~1.000 | 5M/hari | <1% |
| **D1 total reads** | **~37.000** | **5M** | **<1%** |

| Storage | Estimasi | Kuota D1 Free | Catatan |
|---|---|---|---|
| Metrics row size | ~100 bytes/row | — | tergantung ukuran kolom `extra`; WITHOUT ROWID + PK composite hemat ~30–40% vs schema dengan `id` surrogate + secondary index |
| 10 server, 30d retention | 10 × 2.880/hari × 30 × 100 B ≈ 85 MB | 5 GB total per akun | <2% |

**Kesimpulan:** Untuk pemakaian personal hingga ~30 server, semua komponen masih jauh di bawah batas free tier. Batas pertama yang akan tercapai adalah **Workers 100K request/hari** saat memantau lebih dari ~34 server dengan interval 30 detik. Storage D1 baru jadi concern saat retensi dinaikkan ke ratusan hari atau jumlah agent puluhan kali lipat.

Mitigasi jika mendekati batas Workers:
- Tingkatkan interval agent ke 60 detik (default Beszel adalah 30 detik)
- Aktifkan batching: agent mengirim bundle 2 menit sekaligus dalam satu POST

Mitigasi jika mendekati batas D1 writes:
- Batching ingest (poin di atas) langsung mengurangi writes proporsional
- Pertimbangkan rollup tabel `metrics_hourly` agar retensi panjang tidak bergantung pada raw rows

---

## 8. Keamanan

### 8.1 Transport

- Semua komunikasi agent → Workers via HTTPS (enforced oleh Cloudflare)
- TLS 1.3 minimum (Cloudflare default)
- Workers tidak expose port selain 443

### 8.2 Autentikasi Agent

- API key di-generate saat penambahan system di dashboard
- Key mentah hanya ditampilkan sekali, di-hash SHA-256 sebelum disimpan di D1
- Rate limiting via **Workers Rate Limiting binding** `INGEST_LIMITER`: maksimal 3 request/menit per token. Per-token (bukan per-IP) untuk menghindari false positive saat banyak agent berada di NAT yang sama, dan mencegah bypass via IP rotation. Threshold 3/min memberi ruang 1 retry di luar rate normal 2/min (interval 30s)

### 8.3 Autentikasi User

- Password di-hash dengan **PBKDF2-SHA256** via WebCrypto (`crypto.subtle.deriveBits`):
  - Iterations: 600.000 (rekomendasi OWASP 2023)
  - Salt: 16 bytes random per password
  - Output: 32 bytes derived key
  - Disimpan dalam format PHC string: `$pbkdf2-sha256$i=<iter>$<base64-salt>$<base64-hash>` agar mudah upgrade algoritma/iterations di kemudian hari
  - Pilihan ini menggantikan bcrypt karena bcrypt cost ≥10 melebihi CPU limit 10ms Workers free tier; PBKDF2 native via WebCrypto tetap muat dalam budget
  - Saat verify sukses, jika iteration count tersimpan < `ITERATIONS` saat ini, hash di-rehash otomatis (transparent upgrade)
- Login throttling: maksimal 5 attempts per 15 menit per email (bukan per IP, karena IP mudah dirotasi). Disimpan di `RATE_KV`
- JWT menggunakan **HS256** dengan secret di Workers Secret. Asymmetric (RS256) tidak diperlukan karena hub adalah satu-satunya signer dan verifier; HS256 lebih simple, lebih cepat, dan key management trivial
- JWT include claim `kid` (key ID) untuk mendukung rotation:
  - Secret disimpan dengan versi: `JWT_SECRET_V1`, `JWT_SECRET_V2`, dst
  - Signer pakai latest version, verifier resolve secret berdasarkan `kid` di header JWT
  - Rotation flow: deploy `JWT_SECRET_V2` → signer switch → verifier accept v1 dan v2 selama window TTL JWT (24 jam) → hapus v1
- JWT expire 24 jam; refresh token 30 hari disimpan di KV

### 8.4 Isolasi Data

- Agent hanya bisa menulis ke `system_id` yang terkait dengan token-nya
- User biasa hanya bisa mengakses `system_id` yang ada di `users.system_ids`
- Admin bisa mengakses semua system

---

## 9. Trade-off & Keterbatasan

| Keterbatasan | Dampak | Mitigasi |
|---|---|---|
| Workers CPU limit 10ms (free) | Logic kompleks bisa timeout | Minimalkan komputasi per-request; cron trigger punya 30s wall time |
| Tidak ada WebSocket push di MVP | Dashboard tidak real-time | Polling dari dashboard setiap 30 detik |
| D1 storage 5GB (free, total per akun) | Historis metrik terbatas | Retention policy + data aggregation harian (lihat section 7) |
| Status agent dihitung tiap query | Sedikit overhead di cron + dashboard | PK `(system_id, ts)` membuat `MAX(ts)` cepat |
| Wire protocol berbeda dari Beszel | Beszel agent tidak compatible | Pantaw agent ditulis sebagai binary terpisah (lihat section 5) |
| Tidak ada real-time push (DO didrop) | Status delay maksimal 2 menit (cron interval) | Acceptable untuk monitoring; tambah DO + WebSocket di fase berikutnya jika perlu |
| Agent tidak punya persistent buffer | Sample selama outage hub >5min hilang | Idempotensi via PK siap; durable buffer bisa ditambahkan post-MVP tanpa server change |
| D1 migrations forward-only | Tidak ada rollback otomatis | Test migrasi di local D1 dulu; backup via `wrangler d1 export` sebelum apply destructive |

---

## 10. Rencana Implementasi

### Fase 1 — Foundation (Minggu 1–2)

- [ ] Inisialisasi mono-project: Vite + Hono + React, struktur folder `src/{server,client,shared}` (lihat 4)
- [ ] Setup `wrangler.toml` dengan Workers Static Assets (`directory = ./dist/client`, `not_found_handling = single-page-application`)
- [ ] Setup Vite plugin: `@cloudflare/vite-plugin` + `@hono/vite-dev-server`
- [ ] ESLint rule `no-restricted-imports` untuk enforce separation client/server
- [ ] Setup struktur `migrations/` dengan `0001_initial.sql` (semua tabel)
- [ ] Setup D1 database (lokal + remote), apply migration awal (`metrics` pakai composite PK `(system_id, ts)` + `WITHOUT ROWID`)
- [ ] Konfigurasi `INGEST_LIMITER` (Workers Rate Limiting binding) di `wrangler.toml`
- [ ] Implementasi endpoint `/api/v1/ingest` (Hono + Valibot validator): validasi token, validasi `ts` window (clock skew), `INSERT OR IGNORE`, write-through `CACHE_KV`
- [ ] Unit test: auth (token valid/invalid/expired), ingest (single/array payload, duplicate retry, clock skew rejection, rate limit)

### Fase 2 — API Lengkap (Minggu 3–4)

- [ ] Endpoint CRUD systems dan users (Hono routes + Valibot schemas di `src/shared/schemas.ts`)
- [ ] Implementasi JWT auth (HS256 dengan `kid` claim, login, refresh, verify); set/clear cookie HttpOnly + SameSite=Strict
- [ ] Login throttling via `RATE_KV` (5 attempts / 15 menit per email)
- [ ] Endpoint metrik historis dengan query time range
- [ ] KV caching untuk latest metrics (read path dashboard)
- [ ] Alert table dan cron trigger alert+status checker
- [ ] Verifikasi Hono RPC client (`hc<AppType>`) bekerja end-to-end (smoke test dari `src/client/lib/api.ts`)

### Fase 3 — Dashboard (Minggu 5–7)

- [ ] Fork UI Beszel (`internal/site/src/`) ke `src/client/`, sesuaikan path import
- [ ] Tambah file `NOTICE` + atribusi di README
- [ ] Replace `lib/api.ts` Beszel: hapus `pocketbase` SDK, ganti dengan Hono RPC client (`hc<AppType>`)
- [ ] Replace `lib/systemsManager.ts`: ganti `pb.subscribe(...)` dengan TanStack Query polling 30s
- [ ] Sesuaikan login flow: cookie HttpOnly + endpoint `/api/v1/auth/login`
- [ ] Hapus komponen fitur yang di-drop: SMART, systemd, OAuth, OTP, fingerprint tokens, public key
- [ ] Sesuaikan systems-table dengan schema Pantaw (status computed dari `MAX(metrics.ts)`)
- [ ] Sesuaikan system detail page (charts) dengan endpoint metrik historis Pantaw
- [ ] Audit i18n: keep struktur Lingui, simplify ke `en` + `id` aktif (locale lain di-keep namun stale)
- [ ] Smoke test SPA + API jalan barengan via `wrangler dev`

### Fase 4 — Agent & Polish (Minggu 8–9)

- [ ] Implementasi Pantaw agent (Go binary): collector + HTTPS POST loop
- [ ] Status code handling + exponential backoff (5s→15s→60s→5m, lalu drop)
- [ ] Validasi NTP saat startup
- [ ] End-to-end testing: agent → Workers → D1 → Dashboard
- [ ] Load testing kalkulasi free tier
- [ ] Dokumentasi setup (README, env vars)
- [ ] Deploy ke production Cloudflare

---

## 11. Keputusan Desain (Resolved)

Bagian ini awalnya berisi pertanyaan terbuka yang sudah diputuskan selama review RFC.

1. **Nama proyek** — ditetapkan: **Pantaw** (dari kata "pantau"). Tidak terikat ke branding Beszel agar punya identitas sendiri.

2. **Database alternatif (Turso)** — ditolak untuk MVP. Mendukung dua database dari awal menambah kompleksitas pada query layer, migration, dan testing tanpa nilai konkret untuk use case self-hosted personal. D1 menjadi satu-satunya pilihan. Abstraction layer DB dapat ditambahkan post-MVP bila ada kebutuhan multi-region read.

3. **WebSocket / real-time push** — ditolak untuk MVP. Dashboard menggunakan polling 30 detik. WebSocket di Cloudflare Workers membutuhkan Durable Objects sebagai endpoint persisten, dan DO sudah didrop dari MVP karena alasan free tier (lihat section 3.2 "Catatan desain"). Real-time push masuk ke roadmap post-MVP bersama DO bila ada kebutuhan nyata.

4. **Multi-user** — schema (`users.role`, `users.system_ids`) tetap mendukung multi-user agar tidak perlu migration di masa depan. Namun UI dan endpoint enforcement di MVP fokus ke skenario **single admin**. Sharing system antar user, invite flow, dan permission UI masuk ke roadmap post-MVP.

5. **Docker / container stats** — disimpan sebagai JSON dalam kolom `metrics.extra`, bukan tabel terdedikasi. Tabel `container_metrics` akan menyebabkan write amplification (1 row per container per ingest) dan dengan cepat melampaui kuota D1 writes free tier. Dashboard MVP cukup menampilkan snapshot container terkini dari kolom `extra`. Tabel terpisah dapat dipertimbangkan post-MVP bila ada kebutuhan time-series per-container.

6. **Migrasi dari Beszel (PocketBase → D1)** — di-defer ke post-MVP. Pantaw ditargetkan untuk pengguna baru atau pengguna Beszel yang nyaman setup ulang. Outline migrasi cukup didokumentasikan sebagai future work di README.

7. **UI dashboard** — di-fork dari Beszel UI (MIT) sebagai starting point, lapisan data fetching diganti dengan Hono RPC client + TanStack Query polling. Visual design, charts, tables, dan struktur komponen dipertahankan untuk menghemat effort. Fitur Beszel yang tidak relevan di Pantaw MVP (SMART, systemd, OAuth/OTP, fingerprint, SSH key) di-drop. Lihat section 4.7.

8. **Mono-project Vite + Hono** — server (Hono Worker) dan SPA (React) di-bundle dalam satu Vite project, di-deploy sebagai satu Cloudflare Worker dengan Workers Static Assets. Keuntungan: single deployment, no CORS, type-safe API client via Hono RPC, shared Valibot schemas. Lihat section 4 (intro) dan 4.1.

9. **Validation library** — **Valibot**. Bundle size lebih kecil dari Zod (~1KB tree-shaken vs ~13KB), konsisten dengan Beszel UI yang akan di-fork, dan punya integrasi resmi dengan Hono via `@hono/valibot-validator`.

10. **Frontend hosting** — **Workers Static Assets**, bukan Cloudflare Pages. Workers Static Assets sekarang adalah rekomendasi resmi Cloudflare untuk full-stack apps; cocok dengan mono-project pattern dan menghilangkan kebutuhan CORS antara API dan UI.

---

## 12. Referensi

- [Beszel repository](https://github.com/henrygd/beszel) (inspirasi + UI source)
- [Cloudflare Workers pricing & limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare D1 documentation](https://developers.cloudflare.com/d1/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) (post-MVP candidate)
- [Hono](https://hono.dev/) — web framework untuk Workers
- [Hono RPC](https://hono.dev/docs/guides/rpc) — type-safe client
- [Valibot](https://valibot.dev/) — schema validation
- [PocketBase documentation](https://pocketbase.io/docs/) (referensi Beszel)

