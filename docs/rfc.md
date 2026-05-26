# RFC: Beszel Cloudflare Hub

**Status:** Draft  
**Tanggal:** 2026-05-26  
**Penulis:** -  
**Repo asal:** https://github.com/henrygd/beszel  

---

## 1. Ringkasan

RFC ini mengusulkan penulisan ulang komponen **hub** dari Beszel — platform monitoring server ringan — agar dapat berjalan sepenuhnya di atas **Cloudflare free tier** tanpa memerlukan VPS atau server tersendiri. Komponen **agent** tidak diubah secara fundamental; hanya mekanisme pengiriman metrik yang disesuaikan dari SSH tunnel ke HTTPS POST.

Nama proyek fork ini: **Beszel Edge Hub** (sementara).

---

## 2. Latar Belakang & Motivasi

Beszel hub saat ini berjalan di atas **PocketBase** — sebuah binary Go yang membutuhkan:

- Filesystem persisten untuk database SQLite
- Long-running process (tidak bisa di-terminate antar request)
- TCP server untuk menerima koneksi SSH dari agent

Ketiga kebutuhan ini tidak kompatibel dengan model eksekusi Cloudflare Workers (stateless, ephemeral, request-response). Akibatnya, menjalankan hub Beszel gratis mengharuskan pengguna memiliki VPS atau server sendiri.

**Tujuan RFC ini:**

1. Merancang arsitektur hub baru yang sepenuhnya berjalan di Cloudflare free tier
2. Mempertahankan kompatibilitas fungsional dengan Beszel agent yang sudah ada
3. Mendokumentasikan trade-off, batasan, dan keputusan desain

---

## 3. Perubahan Arsitektur

### 3.1 Arsitektur Lama (Beszel Original)

```
Agent (di setiap server)
  └─── SSH reverse tunnel ──→ Hub (PocketBase + SQLite, VPS)
                                    └─── HTTP ──→ Browser (dashboard)
```

- Agent membuka SSH tunnel ke hub
- Hub menerima metrik melalui tunnel
- Hub menyajikan dashboard via web server PocketBase
- SQLite file disimpan di disk VPS

### 3.2 Arsitektur Baru (Beszel Edge Hub)

```
Agent (di setiap server)
  └─── HTTPS POST /ingest ──→ Cloudflare Workers (API)
                                    ├─── D1 / Turso (penyimpanan metrik)
                                    ├─── KV (session & token cache)
                                    ├─── Durable Objects (state per agent)
                                    └─── Cloudflare Pages (dashboard SPA)
                                              └─── Browser (dashboard)

Workers Cron Trigger (alert checker, tiap 1–5 menit)
```

**Perubahan kunci:**

| Komponen | Lama | Baru |
|---|---|---|
| Transport agent→hub | SSH reverse tunnel | HTTPS POST |
| Runtime hub | Go binary (PocketBase) | Cloudflare Workers (TypeScript) |
| Database | SQLite (file di disk) | D1 (SQLite-compatible) atau Turso |
| State management | In-memory PocketBase | Durable Objects |
| Auth | PocketBase built-in | JWT + API Key, diverifikasi di Workers |
| Dashboard UI | PocketBase auto-UI | SPA (React/Vue) di Cloudflare Pages |
| Alert scheduler | PocketBase hooks | Workers Cron Trigger |
| Hosting | VPS (berbayar) | Cloudflare free tier |

---

## 4. Spesifikasi Komponen

### 4.1 Workers API (Hub Core)

Ditulis dalam TypeScript, di-deploy sebagai Cloudflare Worker.

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

**Autentikasi dua lapis:**

- **Agent → Hub:** API key stateless, dikirim sebagai header `Authorization: Bearer <key>`. Key di-hash (SHA-256) dan disimpan di D1 table `agent_tokens`.
- **User → Hub:** Username + password → JWT (RS256, expire 24 jam). JWT di-verify di Workers tanpa DB lookup per-request. Refresh token disimpan di KV dengan TTL 30 hari.

### 4.2 Durable Objects (Agent State Manager)

Setiap agent memiliki satu Durable Object dengan ID = `system_id`. DO bertugas:

- Menyimpan `last_seen` timestamp
- Menyimpan buffer metrik 1 menit sebelum di-flush ke D1 (mengurangi write)
- Menentukan status koneksi: `up` / `down` / `unknown`
- Mentrigger webhook alert jika agent tidak check-in dalam `timeout_seconds`

DO di-alarm setiap 60 detik menggunakan [DO Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) untuk mendeteksi agent yang mati.

### 4.3 Database Schema

Database: **Cloudflare D1** (primer) atau **Turso** (opsional, untuk multi-region read).

#### Tabel `systems`

```sql
CREATE TABLE systems (
  id          TEXT PRIMARY KEY,        -- nanoid atau uuid
  name        TEXT NOT NULL UNIQUE,
  host        TEXT NOT NULL,           -- hostname/IP agent (informational)
  status      TEXT DEFAULT 'unknown',  -- up | down | unknown
  agent_token_hash TEXT NOT NULL,      -- SHA-256 dari API key
  created_at  INTEGER NOT NULL,        -- unix timestamp
  updated_at  INTEGER NOT NULL,
  info        TEXT                     -- JSON: OS, kernel, uptime, dll
);
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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
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
  extra      TEXT                      -- JSON: GPU, container stats, dll
);

CREATE INDEX idx_metrics_system_ts ON metrics (system_id, ts DESC);
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

### 4.4 KV Namespaces

| Namespace | Key | Value | TTL |
|---|---|---|---|
| `SESSION_KV` | `session:{user_id}:{jti}` | JSON user info | 30 hari |
| `RATE_KV` | `rate:{ip}:{endpoint}` | Counter JSON | 60 detik |
| `CACHE_KV` | `metrics:{system_id}:latest` | JSON metrik terakhir | 35 detik |

Cache KV untuk metrik terakhir penting: setiap kali dashboard di-poll, Workers membaca dari KV (sub-ms) bukan dari D1, menghemat rows read secara signifikan.

### 4.5 Cron Triggers

| Trigger | Schedule | Fungsi |
|---|---|---|
| Alert checker | `*/2 * * * *` | Evaluasi semua alert, kirim webhook jika threshold terpenuhi |
| Metrics cleanup | `0 2 * * *` | Hapus metrik lebih lama dari `RETENTION_DAYS` |
| Status sync | `* * * * *` | Sync status agent dari DO ke D1 `systems.status` |

### 4.6 Dashboard SPA (Cloudflare Pages)

Frontend dibangun dengan **React + Vite**, di-deploy ke Cloudflare Pages. Static assets gratis dan unlimited.

Fitur minimal untuk MVP:

- Login page
- Dashboard: daftar semua system dengan status real-time
- System detail: grafik CPU, memory, disk, network (time range: 1j, 6j, 24j, 7d)
- Alert management: buat dan edit alert threshold
- Settings: tambah/hapus system, generate API key

Komunikasi ke Workers API menggunakan JWT yang disimpan di `localStorage` (atau cookie HttpOnly untuk keamanan lebih).

---

## 5. Perubahan pada Agent

Agent Beszel saat ini menggunakan SSH reverse tunnel. Untuk kompatibilitas dengan Workers, agent perlu dimodifikasi:

### Opsi A — Modifikasi minimal (rekomendasi)

Tambahkan mode baru `--transport http` pada binary agent Go yang sudah ada. Dalam mode ini, agent melakukan:

```
Loop setiap 30 detik:
  1. Kumpulkan metrik (CPU, mem, disk, dll) — sama seperti sekarang
  2. Serialize ke JSON
  3. HTTPS POST ke {HUB_URL}/api/v1/ingest
     Header: Authorization: Bearer {AGENT_TOKEN}
  4. Jika response bukan 2xx, log error dan retry di interval berikutnya
```

Konfigurasi agent:

```env
HUB_URL=https://your-hub.workers.dev
AGENT_TOKEN=<api-key-dari-dashboard>
TRANSPORT=http          # default: ssh (backward compat)
INTERVAL=30             # detik
```

### Opsi B — Fork terpisah

Buat `beszel-agent-edge` sebagai binary Go terpisah yang hanya mendukung HTTP transport. Lebih bersih tapi butuh maintenance dua codebase.

**Rekomendasi: Opsi A** — modifikasi minimal pada agent, backward compatible.

---

## 6. Payload Ingestion

Agent mengirim metrik dalam format JSON berikut setiap interval:

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

Workers memvalidasi payload ini, mengekstrak `system_id` dari token, lalu menulis ke D1 dan mengupdate DO state.

---

## 7. Kalkulasi Free Tier

Asumsi: **10 server**, polling interval **30 detik**, **20 dashboard page load/hari**.

| Sumber | Request/hari | Kuota Free | Persentase |
|---|---|---|---|
| Workers (agent ingest) | 28.800 | 100.000/hari | 29% |
| Workers (dashboard API) | 100 | 100.000/hari | <1% |
| Workers (cron alert) | 720 | 100.000/hari | <1% |
| **Workers total** | **29.620** | **100.000** | **~30%** |

| Sumber | Rows/hari | Kuota D1 Free | Persentase |
|---|---|---|---|
| D1 writes (ingest) | 28.800 | ~100K/hari | ~29% |
| D1 reads (ingest + auth) | 86.400 | ~5M/hari | ~2% |
| D1 reads (dashboard) | 1.000 | ~5M/hari | <1% |
| **D1 total reads** | **~87.400** | **~5M** | **~2%** |

**Kesimpulan:** Untuk pemakaian personal hingga ~30 server, semua komponen masih jauh di bawah batas free tier. Batas pertama yang akan tercapai adalah **Workers 100K request/hari** saat memantau lebih dari ~34 server dengan interval 30 detik.

Mitigasi jika mendekati batas Workers:
- Tingkatkan interval agent ke 60 detik (default Beszel adalah 30 detik)
- Aktifkan batching: agent mengirim bundle 2 menit sekaligus dalam satu POST

---

## 8. Keamanan

### 8.1 Transport

- Semua komunikasi agent → Workers via HTTPS (enforced oleh Cloudflare)
- TLS 1.3 minimum (Cloudflare default)
- Workers tidak expose port selain 443

### 8.2 Autentikasi Agent

- API key di-generate saat penambahan system di dashboard
- Key mentah hanya ditampilkan sekali, di-hash SHA-256 sebelum disimpan di D1
- Rate limiting via KV: maksimal 10 request/menit per IP untuk endpoint `/ingest`

### 8.3 Autentikasi User

- Password di-hash dengan **PBKDF2-SHA256** via WebCrypto (`crypto.subtle.deriveBits`):
  - Iterations: 600.000 (rekomendasi OWASP 2023)
  - Salt: 16 bytes random per password
  - Output: 32 bytes derived key
  - Disimpan dalam format PHC string: `$pbkdf2-sha256$i=<iter>$<base64-salt>$<base64-hash>` agar mudah upgrade algoritma/iterations di kemudian hari
  - Pilihan ini menggantikan bcrypt karena bcrypt cost ≥10 melebihi CPU limit 10ms Workers free tier; PBKDF2 native via WebCrypto tetap muat dalam budget
  - Saat verify sukses, jika iteration count tersimpan < `ITERATIONS` saat ini, hash di-rehash otomatis (transparent upgrade)
- Login throttling: maksimal 5 attempts per 15 menit per email (bukan per IP, karena IP mudah dirotasi). Disimpan di `RATE_KV`
- JWT menggunakan RS256 (private key disimpan di Workers Secret)
- JWT expire 24 jam; refresh token 30 hari disimpan di KV

### 8.4 Isolasi Data

- Agent hanya bisa menulis ke `system_id` yang terkait dengan token-nya
- User biasa hanya bisa mengakses `system_id` yang ada di `users.system_ids`
- Admin bisa mengakses semua system

---

## 9. Trade-off & Keterbatasan

| Keterbatasan | Dampak | Mitigasi |
|---|---|---|
| Workers CPU limit 10ms (free) | Logic kompleks bisa timeout | Minimalkan komputasi per-request; cron trigger punya 30s |
| Tidak ada WebSocket push di free tier | Dashboard tidak real-time | Polling dari dashboard setiap 30 detik |
| D1 max 500MB per database (free) | Historis metrik terbatas | Retention policy + data aggregation harian |
| DO hanya SQLite storage di free tier | Tidak bisa pakai KV DO | Sudah didesain pakai SQLite DO dari awal |
| Cold start DO (~100ms) | Latency spike sesekali | Acceptable untuk use case monitoring |
| Tidak ada SSH tunnel | Perlu modifikasi agent | Opsi A backward-compatible |

---

## 10. Rencana Implementasi

### Fase 1 — Foundation (Minggu 1–2)

- [ ] Inisialisasi project Cloudflare Workers dengan Wrangler
- [ ] Setup D1 database, migrate schema
- [ ] Implementasi endpoint `/api/v1/ingest` dengan autentikasi API key
- [ ] Implementasi Durable Object dasar (state per agent, last_seen tracking)
- [ ] Unit test untuk auth dan ingestion logic

### Fase 2 — API Lengkap (Minggu 3–4)

- [ ] Endpoint CRUD systems dan users
- [ ] Implementasi JWT auth (login, refresh, verify)
- [ ] Endpoint metrik historis dengan query time range
- [ ] KV caching untuk latest metrics
- [ ] Alert table dan cron trigger alert checker

### Fase 3 — Dashboard (Minggu 5–7)

- [ ] Setup Cloudflare Pages + React + Vite
- [ ] Halaman login
- [ ] Dashboard utama: daftar system + status
- [ ] System detail page: grafik time-series (menggunakan Recharts atau Chart.js)
- [ ] Alert management UI
- [ ] Settings: tambah system, generate token

### Fase 4 — Agent & Polish (Minggu 8–9)

- [ ] Fork/modifikasi agent: tambah mode HTTP transport
- [ ] End-to-end testing: agent → Workers → D1 → Dashboard
- [ ] Load testing kalkulasi free tier
- [ ] Dokumentasi setup (README, env vars)
- [ ] Deploy ke production Cloudflare

---

## 11. Pertanyaan Terbuka

1. **Nama proyek** — tetap `beszel-edge` atau nama baru?
2. **Opsi Turso** — perlu diimplementasikan dari awal, atau sebagai plugin opsional di fase berikutnya?
3. **WebSocket support** — apakah real-time push dari Durable Objects perlu di MVP, atau cukup polling?
4. **Multi-user** — apakah MVP perlu sistem sharing system antar user, atau cukup single admin dulu?
5. **Docker stats** — agent meneruskan container stats; apakah perlu schema khusus atau cukup masuk ke kolom `extra` JSON?
6. **Backward compatibility** — jika ada pengguna Beszel original yang ingin migrasi, perlu tool migrasi dari PocketBase SQLite ke D1?

---

## 12. Referensi

- [Beszel repository](https://github.com/henrygd/beszel)
- [Cloudflare Workers pricing & limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare D1 documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Turso pricing](https://turso.tech/pricing)
- [PocketBase documentation](https://pocketbase.io/docs/)

