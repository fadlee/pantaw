# Improvement Plan: Pantaw

**Status:** Draft
**Tanggal:** 2026-09-23
**Basis:** audit codebase pada commit `f04dd48` (v0.2.0)

Dokumen ini mendaftar perbaikan yang teridentifikasi dari audit server, agent,
client, dan tooling. Urutan prioritas: P0 (correctness / free-tier budget),
P1 (hardening & proses), P2 (utang teknis client), P3 (post-MVP).

Setiap item punya format: **Masalah → Perbaikan → Verifikasi**.

---

## P0 — Blocking / kuota free tier

### P0.1 Hapus KV write di hot path ingest

**Masalah.** `src/server/routes/ingest.ts:115` menulis `metrics:{system_id}:latest`
ke `CACHE_KV` di setiap request. Satu agent dengan interval 30 detik = 2.880 KV
write/hari, sedangkan free tier Workers KV hanya 1.000 write/hari. Kuota habis
dengan satu agent saja. Lebih jauh: key ini tidak pernah dibaca di mana pun
(`grep CACHE_KV` hanya menemukan write di ingest dan assertion di
`tests/ingest.spec.ts:179`).

**Perbaikan.** Hapus blok KV write beserta test-nya. Jika nanti butuh cache
"latest metrics" untuk dashboard, baca dari D1 (`ORDER BY ts DESC LIMIT 1`, murah
karena PK `(system_id, ts)`) atau pakai Cache API yang tidak punya limit harian.

**Verifikasi.** `bun run test` hijau; tidak ada referensi `CACHE_KV` tersisa di
`src/`. Opsional: hapus binding `CACHE_KV` dari `wrangler.toml` bila benar-benar
tidak dipakai.

### P0.2 Enforce per-user authorization (`users.system_ids`)

**Masalah.** Kolom `users.system_ids` ada di skema tapi tidak pernah dibaca.
`GET /api/v1/systems`, `GET /api/v1/systems/:id`, `GET /api/v1/systems/:id/metrics`,
dan `GET /api/v1/alerts` mengembalikan seluruh data ke user manapun yang
terautentikasi. `requireAdmin` hanya menjaga endpoint write. Akibatnya role
`user` setara admin untuk semua operasi baca.

**Perbaikan.**
1. Tambah `systemIds: string[]` ke `UserAuthVars`, di-load `userAuth` dari kolom
   `system_ids` (atau embed di JWT claim saat login untuk menghindari DB lookup
   per request — perhatikan invalidation saat akses diubah).
2. Helper `scopeSystems(c)`: admin → tanpa filter; user → `WHERE id IN (...)`
   / `WHERE system_id IN (...)`. Terapkan di `systems.ts` (list, detail, metrics)
   dan `alerts.ts` (list).
3. `:id` yang di luar scope → 404 (bukan 403), supaya tidak membocorkan eksistensi.

**Verifikasi.** Test baru: user non-admin dengan `system_ids=["A"]` hanya melihat
system A di list, dapat 404 untuk `/systems/B` dan `/systems/B/metrics`.

### P0.3 Perbaiki logika sustained breach pada alert

**Masalah.** `evaluateAlert` (`src/server/cron.ts:99`) menyatakan breaching bila
**semua** sample dalam window melanggar threshold, tanpa cek jumlah sample minimum
atau cakupan window. Satu datapoint dalam window 5 menit langsung memicu alert —
agent yang baru online bisa fire seketika, dan `duration_s` praktis tidak berarti.

**Perbaikan.** Tambah dua syarat sebelum menyatakan breaching:
- jumlah sample >= `ceil(duration_s / expected_interval)` dengan lantai minimum
  (mis. 2), atau
- sample paling lama dalam window <= `now - duration_s + toleransi`.

Query sudah mengambil semua baris; cukup ikut `SELECT ts` dan cek `MIN(ts)`.

**Verifikasi.** Test di `tests/cron.spec.ts`: satu sample breaching dalam window
`duration_s=300` **tidak** fire; sample yang merentang penuh window fire.

### P0.4 Hentikan write D1 mubazir per ingest

**Masalah.** `UPDATE systems SET host = ... WHERE id = ? AND (host = '' OR host IS NULL)`
(`ingest.ts:108`) dieksekusi di setiap ingest walaupun `host` sudah terisi. Guard
di SQL mencegah perubahan baris, bukan eksekusi statement — RFC menargetkan
1 D1 write per ingest.

**Perbaikan.** Gabungkan `host` ke query lookup token di `agentAuth` (sudah ada
SELECT ke `agent_tokens`; join ke `systems`), lalu jalankan UPDATE hanya bila
`host` kosong.

**Verifikasi.** Test yang sudah ada tetap hijau; tambahkan assertion bahwa ingest
kedua tidak mengubah `host` yang sudah terisi.

### P0.5 Naikkan headroom rate limit ingest

**Masalah.** `wrangler.toml`: `simple = { limit = 3, period = 60 }` per token,
sementara agent default mengirim 2 request/menit dan minimum `INTERVAL` yang
diizinkan agent adalah 5 detik (12 req/menit). Interval 15 detik langsung
kena limit, dan retry backoff memakan sisa jatah.

**Perbaikan.** Naikkan ke `limit = 15, period = 60` (masih jauh di bawah ambang
abuse), atau selaraskan dengan `INTERVAL` minimum yang didukung agent lalu
dokumentasikan di `agent/README.md`.

**Verifikasi.** Agent dengan `INTERVAL=10` berjalan tanpa 429.

---

## P1 — Hardening & proses

### P1.1 CI untuk push dan pull request

**Masalah.** Hanya ada `.github/workflows/release.yml` yang jalan saat tag `v*`.
Typecheck, test, dan lint tidak pernah otomatis — regresi baru ketahuan saat rilis.

**Perbaikan.** Tambah `.github/workflows/ci.yml`: trigger `push` ke `main` dan
`pull_request`; job `bun install --frozen-lockfile`, `bun run typecheck`,
`bun run test`, `bun run check`; plus job terpisah `go vet ./...` dan
`go build ./...` di `agent/`.

**Verifikasi.** Workflow hijau di PR percobaan.

### P1.2 Satu sumber kebenaran untuk skema D1

**Masalah.** `migrations/0001_initial.sql` dan `INITIAL_SCHEMA` di
`src/server/lib/schema.ts` adalah dua salinan manual. Keduanya cocok hari ini;
kolom berikutnya yang ditambahkan di salah satu sisi akan drift diam-diam.

**Perbaikan.** Pilih satu:
- **(a)** `schema.ts` jadi sumber tunggal, dan file migration di-generate dari
  array itu lewat script (`bun run scripts/gen-migration.ts`); atau
- **(b)** tetap pakai `migrations/` sebagai sumber, dan `ensureSchema` membaca
  isi file yang di-inline saat build.

Rekomendasi: (a) — lebih sederhana, dan auto-init memang sudah jadi jalur utama
sejak `e77602b`. Tambah test yang membandingkan kedua artefak agar drift gagal
di CI.

**Verifikasi.** Test `tests/schema.spec.ts` diperluas: DDL dari migration ==
DDL dari `INITIAL_SCHEMA`.

### P1.3 Revokasi dan lifecycle agent token

**Masalah.** `POST /systems/:id/tokens` (`systems.ts:139`) menambah baris token
baru tapi tidak menghapus yang lama dan tidak memperbarui
`systems.agent_token_hash`. Tidak ada endpoint delete. Token lama valid selamanya
— "rotasi" tidak merotasi apa pun. `agent_tokens.last_used` juga tidak pernah
ditulis, jadi halaman settings tidak bisa menampilkan token mana yang aktif.

**Perbaikan.**
1. `GET /systems/:id/tokens` — daftar token (id, label, created_at, last_used;
   tanpa hash).
2. `DELETE /systems/:id/tokens/:tokenId` — revoke; tolak bila itu token terakhir.
3. Opsi `?revoke_others=true` pada endpoint rotate.
4. Hapus kolom `systems.agent_token_hash` yang kini redundan dengan tabel
   `agent_tokens`, atau jaga tetap sinkron saat rotate.
5. `last_used`: update best-effort via `ctx.waitUntil`, throttle (mis. tulis
   hanya bila `last_used` lebih tua dari 1 jam) supaya tidak menambah write per
   ingest.

**Verifikasi.** Test: token yang direvoke mendapat 401 pada ingest; rotate dengan
`revoke_others` mematikan token lama.

### P1.4 Error handling cron

**Masalah.** `scheduled` di `src/server/index.ts:90` membungkus semuanya dalam
`ctx.waitUntil` tanpa catch — kegagalan cron tidak menandai run sebagai failed
dan tidak muncul jelas di observability.

**Perbaikan.** `await` handler-nya (Workers memberi wall time untuk scheduled),
log terstruktur pada error, dan re-throw agar run tercatat gagal.

**Verifikasi.** Test cron yang melempar error tetap mempropagasi.

### P1.5 README dan dokumentasi entry point

**Masalah.** Tidak ada `README.md` di root, padahal `install-agent.sh` merujuk
`https://github.com/fadlee/pantaw`. Pengunjung repo tidak menemukan apa pun.

**Perbaikan.** `README.md`: ringkasan produk, diagram arsitektur, quick start
(deploy hub → setup admin → add system → jalankan installer agent), link ke
`docs/design/rfc.md` dan `docs/deploy-cloudflare.md`, catatan batas free tier.
Pertimbangkan `README.en.md` karena installer menyasar audiens internasional.

### P1.6 Perbaiki `bun run check`

**Masalah.** `bun run check` gagal: 13 error + 3 warning, mayoritas di
`scripts/release.ts` (`noExplicitAny`, `useTemplate`, `noGlobalIsNan`), plus
`src/server/routes/ingest.ts` dan `tests/ingest.spec.ts` yang belum terformat.

**Perbaikan.** `bunx biome check --fix`, lalu perbaiki manual sisa `any` di
`scripts/release.ts`. Jadikan gate di CI (P1.1) agar tidak kambuh.

---

## P2 — Utang teknis client

### P2.1 Masukkan `src/client` ke lint & format

**Masalah.** `biome.json` meng-ignore `src/client` sepenuhnya — sekitar 10k baris
(dua pertiga kodebase) tidak pernah di-lint maupun diformat.

**Perbaikan.** Hapus `"src/client"` dari `files.ignore`, sisakan
`src/client/locales` (file generated). Jalankan `biome check --fix`, commit
formatting sebagai commit terpisah agar diff review tetap terbaca, lalu
naikkan rule satu per satu jika muncul terlalu banyak error sekaligus.

### P2.2 Bongkar shim PocketBase

**Masalah.** `src/client/lib/api.ts:120-192` adalah stub `pb` warisan Beszel:
~15 method yang `Promise.reject(new Error("not implemented"))` (OTP, OAuth,
CRUD collection). Dua komponen masih membaca `pb.authStore.record` untuk email
user (`navbar.tsx:80`, `navbar.tsx:140`).

**Perbaikan.** Ganti pembacaan `pb.authStore.record` dengan `getCurrentUser()`
yang sudah ada, lalu hapus objek `pb`. Komponen yang jadi error saat kompilasi
adalah daftar pekerjaan yang tersisa.

**Verifikasi.** `bun run typecheck` hijau tanpa `pb` di `src/client`.

### P2.3 Sembunyikan fitur UI yang tidak punya backend

**Masalah.** UI hasil fork membawa fitur yang tidak ada di Pantaw: tabel SMART,
systemd, chart GPU, paused systems, SSH fingerprints, login OTP/OAuth. Tipe alert
Bandwidth/GPU/LoadAvg di-drop diam-diam di `alerts-sheet.tsx:102`
(`if (!metric) return`) — toggle tampil tapi tidak melakukan apa-apa.

**Perbaikan.** Untuk tiap fitur, pilih eksplisit: hapus komponennya, atau
tampilkan disabled + tooltip "not supported yet". Minimal, hilangkan tipe alert
yang tidak didukung dari `alertInfo` sehingga tidak pernah ter-render.

### P2.4 Hapus `src/locales` yang mati

**Masalah.** `src/locales/` (30 file, ter-track git) tidak dipakai: Lingui
menulis ke `src/client/locales/` (`lingui.config.ts:43`) dan `@/locales`
me-resolve ke sana juga (alias `@` → `src/client`).

**Perbaikan.** `git rm -r src/locales`. Verifikasi `bun run build` dan
pergantian bahasa di UI tetap jalan.

### P2.5 Kurangi ukuran bundle locale

**Masalah.** `src/client/locales` ~2,5 MB; semua locale ikut ter-build.

**Perbaikan.** Sudah lazy via dynamic import — pastikan chunking Vite benar dan
tidak ada locale yang masuk entry chunk. Pertimbangkan memangkas ke locale yang
benar-benar punya terjemahan lengkap (`ro`, `th` tidak punya `.ts`, hanya `.po`).

### P2.6 Test untuk client dan agent

**Masalah.** Nol test di `src/client` dan di `agent/` (Go).

**Perbaikan.** Prioritaskan yang berisiko dan murah: `lib/utils.ts` (formatting
bytes/temp), `chart-data.ts` (agregasi & monotonic ts — sumber bug `966af9a`),
`systemsManager` (mapping status). Di Go: `collector_test.go` untuk perhitungan
delta network/disk, dan `sender_test.go` untuk logika retry/backoff dengan
`httptest`.

---

## P3 — Post-MVP

- **Refresh token.** `SESSION_KV` ter-bind tapi tidak pernah dipakai; sesi mati
  keras di 24 jam (`auth.ts:200`). Implementasikan refresh token 30 hari sesuai
  RFC 4.1, atau lepas binding-nya.
- **Manajemen user.** Belum ada endpoint create/list/delete user selain `/setup`.
  Dibutuhkan agar `system_ids` (P0.2) benar-benar bisa dikelola.
- **Efisiensi cron alert.** `evaluateAlert` melakukan satu query D1 per alert per
  run. Pada puluhan alert ini N+1; bisa digabung jadi satu query beragregasi per
  system.
- **Notifikasi selain webhook.** Email/Telegram/Discord — halaman settings
  notifications sudah ada rangkanya.
- **Edit system.** `add-system.tsx:300` menandai dialog edit sebagai stub.
- **Retensi bertingkat.** Sekarang hanya DELETE berbasis `RETENTION_DAYS`;
  downsampling ke bucket per jam akan memperpanjang riwayat tanpa menambah
  storage.

---

## Urutan eksekusi yang disarankan

1. **Batch 1 (setengah hari):** P0.1, P0.4, P0.5, P1.6 — perubahan kecil,
   dampak kuota langsung.
2. **Batch 2 (satu hari):** P1.1 lebih dulu supaya batch berikutnya terjaga,
   lalu P0.3 dan P1.2.
3. **Batch 3 (satu–dua hari):** P0.2 + P1.3 — keduanya menyentuh model auth,
   lebih murah dikerjakan bersama.
4. **Batch 4 (berkelanjutan):** P2.1 → P2.2 → P2.4, lalu sisanya.
5. **P1.5 (README)** dapat dikerjakan kapan saja dan sebaiknya mendahului
   promosi repo ke publik.
