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
  └─── HTTPS POST /ingest ──→ Cloudflare Workers (API)
                                    ├─── D1 (penyimpanan metrik)
                                    ├─── KV (session, rate-limit, latest-metrics cache)
                                    └─── Cloudflare Pages (dashboard SPA)
                                              └─── Browser (dashboard)

Workers Cron Trigger (alert + status checker, tiap 2 menit)
```

**Perubahan dari arsitektur referensi:**

| Komponen | Beszel | Pantaw |
|---|---|---|
| Transport agent→hub | SSH reverse tunnel | HTTPS POST |
| Runtime hub | Go binary (PocketBase) | Cloudflare Workers (TypeScript) |
| Database | SQLite (file di disk) | D1 (SQLite-compatible) |
| State management | In-memory PocketBase | Stateless Workers + D1 (status dihitung dari `MAX(metrics.ts)`) |
| Auth | PocketBase built-in | JWT + API Key, diverifikasi di Workers |
| Dashboard UI | PocketBase auto-UI | SPA (React/Vite) di Cloudflare Pages |
| Alert scheduler | PocketBase hooks | Workers Cron Trigger |
| Hosting | VPS (berbayar) | Cloudflare free tier |

**Catatan desain:** Versi awal RFC ini sempat memasukkan Durable Objects untuk per-agent state, buffer metrik, dan deteksi agent down via DO Alarms. Setelah dihitung ulang, kombinasi ingest + alarm DO untuk 10 agent menghasilkan ~1,3 juta DO invocation/bulan, sudah melampaui DO free tier (1M/bulan), padahal manfaatnya bisa dicapai cukup dengan kolom `last_seen` di D1 atau perhitungan dinamis dari `MAX(metrics.ts)`. Karena MVP juga tidak membutuhkan WebSocket fan-out (lihat section 11 #3), DO didrop dari arsitektur. Dapat ditambahkan kembali di fase berikutnya bila real-time push diperlukan.

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
  3. INSERT OR IGNORE INTO metrics (system_id, ts, ...)  -- idempotent via UNIQUE(system_id, ts)
  4. Update CACHE_KV: metrics:{system_id}:latest = payload (TTL 90s)
  5. Update agent_tokens.last_used (best-effort, boleh di-skip jika hot path)
  6. Return 204
```

Ingest hanya melakukan **1 D1 write** ke tabel `metrics`. Tabel `systems` tidak di-update per-ingest sehingga write D1 tidak berlipat ganda.

**Deteksi agent down:** dilakukan oleh cron trigger (lihat 4.5) yang menscan systems dan membandingkan `MAX(metrics.ts)` dengan `now - timeout_seconds`. Jika transition `up → down`, kirim webhook dan log ke `alerts.last_fired`.

**Idempotensi:** Tambah constraint `UNIQUE(system_id, ts)` ke tabel `metrics`. Jika agent retry POST yang sudah berhasil tertulis, `INSERT OR IGNORE` mengabaikan duplikat tanpa error.

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
  extra      TEXT,                     -- JSON: GPU, container stats, dll
  UNIQUE(system_id, ts)                 -- idempotensi ingest retry
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
| Alert + status checker | `*/2 * * * *` | Untuk tiap system: hitung status dari `MAX(metrics.ts)`, deteksi transition up↔down, evaluasi threshold alert (cpu/mem/disk/temp), kirim webhook jika perlu, update `systems.last_status` jika berubah |
| Metrics cleanup | `0 2 * * *` | Hapus metrik lebih lama dari `RETENTION_DAYS` |

Semua kebutuhan periodic dikonsolidasi ke satu cron `*/2 * * * *` agar invocation Workers cron tetap minimal (~720/hari) dan logic state-transition alert tidak race dengan status sync.

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

## 5. Agent

Pantaw membutuhkan agent yang berjalan di tiap server target untuk mengumpulkan metrik dan mengirimkannya ke hub via HTTPS POST. Untuk MVP, agent ditulis sebagai binary Go terpisah dengan footprint minimal (mirip Beszel agent dalam semangat dan ukuran).

**Karakteristik agent:**

```
Loop setiap INTERVAL detik (default 30):
  1. Kumpulkan metrik (CPU, mem, disk, net, load, temp)
  2. Optional: kumpulkan container stats (Docker)
  3. Serialize ke JSON
  4. HTTPS POST ke {HUB_URL}/api/v1/ingest
     Header: Authorization: Bearer {AGENT_TOKEN}
  5. Jika response bukan 2xx, log error dan retry di interval berikutnya
```

**Konfigurasi agent:**

```env
HUB_URL=https://your-hub.workers.dev
AGENT_TOKEN=<api-key-dari-dashboard>
INTERVAL=30             # detik
```

**Catatan tentang Beszel agent:** Karena wire protocol Pantaw (HTTPS POST) berbeda dari Beszel (SSH tunnel), Beszel agent tidak bisa langsung digunakan. Pengguna existing Beszel yang ingin mencoba Pantaw perlu mengganti binary agent. Tool migrasi dari PocketBase ke D1 di-defer ke post-MVP (lihat section 11).

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
| Metrics row size | ~150 bytes/row | — | tergantung ukuran kolom `extra` |
| 10 server, 30d retention | 10 × 28.800/10 × 30 × 150 B ≈ 130 MB | 5 GB total per akun | <3% |

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
| Workers CPU limit 10ms (free) | Logic kompleks bisa timeout | Minimalkan komputasi per-request; cron trigger punya 30s wall time |
| Tidak ada WebSocket push di MVP | Dashboard tidak real-time | Polling dari dashboard setiap 30 detik |
| D1 storage 5GB (free, total per akun) | Historis metrik terbatas | Retention policy + data aggregation harian (lihat section 7) |
| Status agent dihitung tiap query | Sedikit overhead di cron + dashboard | Index `(system_id, ts DESC)` membuat `MAX(ts)` cepat |
| Tidak ada SSH tunnel | Perlu modifikasi agent | Opsi A backward-compatible |
| Tidak ada real-time push (DO didrop) | Status delay maksimal 2 menit (cron interval) | Acceptable untuk monitoring; tambah DO + WebSocket di fase berikutnya jika perlu |

---

## 10. Rencana Implementasi

### Fase 1 — Foundation (Minggu 1–2)

- [ ] Inisialisasi project Cloudflare Workers dengan Wrangler
- [ ] Setup D1 database, migrate schema (termasuk constraint `UNIQUE(system_id, ts)` di `metrics`)
- [ ] Implementasi endpoint `/api/v1/ingest` dengan autentikasi API key
- [ ] Implementasi `CACHE_KV` write-through pada path ingest
- [ ] Unit test untuk auth dan ingestion logic (termasuk skenario retry/duplikat)

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

- [ ] Implementasi Pantaw agent (Go binary): collector + HTTPS POST loop
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

---

## 12. Referensi

- [Beszel repository](https://github.com/henrygd/beszel) (inspirasi)
- [Cloudflare Workers pricing & limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare D1 documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) (post-MVP candidate)
- [PocketBase documentation](https://pocketbase.io/docs/)

