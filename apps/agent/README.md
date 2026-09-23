# Pantaw Agent

Go agent untuk Pantaw. Mengumpulkan metrik sistem lalu mengirimkannya ke hub via HTTPS POST.

## Fitur MVP

- CPU, memory, disk usage
- Disk I/O bytes/s
- Network I/O bytes/s
- Load average (1, 5, 15 min)
- Temperature (best-effort)
- Uptime
- Optional Docker container stats via `/var/run/docker.sock`
- Exponential backoff on send errors

## Konfigurasi

Env vars:

- `HUB_URL` — required, contoh `https://your-hub.workers.dev`
- `AGENT_TOKEN` — required, token dari dashboard Pantaw
- `INTERVAL` — optional, detik, default `30` (minimum `5`). Default 30s = 2 req/menit; minimum 5s = 12 req/menit.
- `DOCKER` — optional, `true` untuk enable container stats, default `false`
- `LOG_LEVEL` — optional, `debug|info|warn|error`, default `info`

Contoh:

```bash
export HUB_URL=https://your-hub.workers.dev
export AGENT_TOKEN=your-token-here
export INTERVAL=30
export DOCKER=true
./pantaw-agent
```

## Build

```bash
cd apps/agent
make build
```

Cross-compile semua target umum:

```bash
cd apps/agent
make build-all
```

Output ada di folder `apps/agent/dist/`.

## Systemd example

File env `/etc/pantaw/agent.env`:

```env
HUB_URL=https://your-hub.workers.dev
AGENT_TOKEN=your-token-here
INTERVAL=30
DOCKER=false
LOG_LEVEL=info
```

Unit file `/etc/systemd/system/pantaw-agent.service`:

```ini
[Unit]
Description=Pantaw Agent
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/pantaw/agent.env
ExecStart=/usr/local/bin/pantaw-agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pantaw-agent
```

## Docker stats

Jika `DOCKER=true`, agent akan baca Docker API via Unix socket `/var/run/docker.sock`.
Tidak pakai Docker SDK agar binary tetap kecil. Pastikan user yang menjalankan agent punya akses ke socket.

## Payload

Agent mengirim payload ke `/api/v1/ingest` seperti ini:

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

## Smoke test yang sudah diverifikasi

- Build binary lokal (`9.0M` di macOS arm64)
- Login ke local hub
- Create system + dapat token
- Manual `curl` ke `/api/v1/ingest` sukses (`204`)
- Jalankan agent 2 interval (`INTERVAL=5`) → metrics masuk ke D1

## Catatan

- Cookie/session tidak dipakai oleh agent, hanya Bearer token
- Tidak ada persistent buffer di MVP; data selama outage bisa hilang
- `INTERVAL` minimum 5 detik (12 req/menit). Rate limiter di hub diset pada 15 req/menit per-token untuk memberikan headroom toleransi.
