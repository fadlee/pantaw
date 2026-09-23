# Deploy ke Cloudflare

## Resource production yang sudah dibuat

- Worker: `pantaw`
- URL: `https://pantaw.fadlee.workers.dev`
- D1: `pantaw` (`70b13a79-b2b1-4148-862f-c12e018a3668`)
- KV `SESSION_KV`: `5ef2ea47791b4a90ae84a602638a4198`
- KV `RATE_KV`: `4e22de223a9a4d9e95c9184a1e20a9d3`

`wrangler.toml` sudah diupdate dengan binding IDs di atas.

## Secret yang wajib ada

Sudah diset:

- `JWT_SECRET_V1`
- `JWT_KID_CURRENT=v1`

Jika perlu rotate nanti:

1. `wrangler secret put JWT_SECRET_V2`
2. `wrangler secret put JWT_KID_CURRENT` dengan nilai `v2`
3. deploy ulang
4. setelah masa JWT lama lewat, hapus `JWT_SECRET_V1`

## Deploy command

```bash
bun run db:migrate:remote
bun run build
npx wrangler deploy
```

## Verify

```bash
curl https://pantaw.fadlee.workers.dev/api/health
curl https://pantaw.fadlee.workers.dev/api/v1/auth/setup-status
```

Expected:

- `/api/health` -> `200` + `{"status":"ok"...}`
- `/api/v1/auth/setup-status` -> `{"needs_setup":true}` pada deploy baru

## Bootstrap admin pertama

Buka:

- `https://pantaw.fadlee.workers.dev`

Lalu jalankan setup user admin pertama dari UI.

## Catatan

- Cron sudah ikut terdeploy dari `wrangler.toml`
- `INGEST_LIMITER` masih pakai config placeholder namespace `1001`; untuk produksi serius sebaiknya diganti ke namespace ratelimit yang benar jika ingin enforcement penuh di Cloudflare runtime
- Saat ini `workers.dev` route aktif dan melayani SPA + API dari Worker yang sama
