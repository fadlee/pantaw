# Pantaw

> Serverless, lightweight server monitoring powered by Cloudflare Workers, D1, and React SPA with a native Go agent.

Pantaw is a modern, cost-efficient server monitoring system designed to run entirely within Cloudflare's free tier. It tracks system resources (CPU, Memory, Disk, Network, Temperatures, Docker containers), evaluates threshold alerts via cron triggers, and visualizes real-time and historical telemetry on a clean dashboard.

---

## Architecture

```
┌─────────────────┐           HTTPS POST            ┌─────────────────────────────┐
│   Go Agent      │  ─── [/api/v1/ingest] ───►      │  Cloudflare Worker (Hono)   │
│ (System/Docker) │    Bearer <agent_token>         ├─────────────────────────────┤
└─────────────────┘                                 │ • Valibot validation        │
                                                    │ • Rate limiting per token   │
                                                    │ • JWT auth & scoped RBAC    │
                                                    │ • Cron alert evaluation     │
                                                    └──────────────┬──────────────┘
                                                                   │
                                            ┌──────────────────────┴──────────────────────┐
                                            ▼                                             ▼
                               ┌───────────────────────────┐                 ┌───────────────────────────┐
                               │  Cloudflare D1 (SQLite)   │                 │   Cloudflare KV & Assets  │
                               ├───────────────────────────┤                 ├───────────────────────────┤
                               │ • systems, metrics        │                 │ • RATE_KV (auth rate limit│
                               │ • users, alerts           │                 │ • ASSETS (React Vite SPA) │
                               │ • agent_tokens            │                 └───────────────────────────┘
                               └───────────────────────────┘                 └───────────────────────────┘
                                            ▲
                                            │
                               ┌────────────┴──────────────┐
                               │   React SPA (Dashboard)   │
                               │   Vite + Tailwind + Hono  │
                               └───────────────────────────┘
```

---

## Features

- **Serverless Hub**: Runs on Cloudflare Workers with D1 SQL database and Workers KV.
- **Ultra-efficient Ingest**: Zero KV writes on the metric ingest hot path; batched SQLite inserts with `WITHOUT ROWID`.
- **Native Go Agent**: Minimal footprint agent (<10MB binary, <15MB RAM) collecting CPU, memory, disk I/O, network I/O, temperatures, load averages, and Docker container stats.
- **Multi-Tenant & Scoped Access**: Admin and regular user roles with per-user `system_ids` authorization.
- **Sustained Breach Alerting**: Cron-driven evaluations that trigger webhooks only after metric thresholds are consistently breached over time.
- **Token Lifecycle**: Multi-token management per monitored system with rotation and single-token protection.

---

## Quickstart: Deploy Hub to Cloudflare

```bash
bunx pantaw deploy        # or: npx pantaw deploy
```

The wizard walks through everything: it opens the Cloudflare API token page with the right permissions pre-selected (Workers Scripts, D1, Workers KV Storage — all Edit), creates the D1 database and KV namespaces, applies migrations, deploys the Worker to `https://<name>.<subdomain>.workers.dev`, generates the JWT signing secret, creates your admin account the moment the hub is up, and can register your first server and print its agent install command.

To upgrade, run `bunx pantaw@latest deploy` (the `@latest` stops bunx/npx from reusing a cached older CLI): it migrates and redeploys the hub version bundled with that CLI release, keeping all data.

| Command | What it does |
|---|---|
| `bunx pantaw deploy [--name <instance>]` | First deploy (wizard) or upgrade of an existing instance |
| `bunx pantaw status [--name <instance>]` | Show an instance's resources and probe its health |
| `bunx pantaw list` | List instances configured on this machine |
| `bunx pantaw destroy [--name <instance>]` | Delete the Worker, D1 database and KV namespaces |

Each instance is named after its Worker (default `pantaw`), so one account can run several (`pantaw`, `pantaw-staging`, …). Their state lives in `~/.config/pantaw/<name>.json` (mode 600); the API token is only stored there if you say so. If a Worker with that name already exists — say one deployed by hand — `deploy` offers to take it over and keeps using the database and namespaces it is bound to.

For CI, pass `--yes` and set `CLOUDFLARE_API_TOKEN` (plus `CLOUDFLARE_ACCOUNT_ID` if the token sees several accounts, and `PANTAW_ADMIN_EMAIL` / `PANTAW_ADMIN_PASSWORD` for the first deploy).

### Manual deploy

Prefer running wrangler yourself? From a clone of this repo:

#### Prerequisites

- [Bun](https://bun.sh) (v1.1+)
- [Cloudflare Account](https://cloudflare.com) and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

#### 1. Clone and Install Dependencies

```bash
git clone https://github.com/fadlee/pantaw.git
cd pantaw
bun install
```

#### 2. Provision Cloudflare Resources

Create the D1 database and KV namespaces:

```bash
# Create D1 Database
bunx wrangler d1 create pantaw

# Create KV Namespaces
bunx wrangler kv namespace create RATE_KV

Update your `wrangler.toml` with the generated database ID and KV namespace IDs.

#### 3. Configure Secrets

Set up JWT signing secrets:

```bash
bunx wrangler secret put JWT_SECRET_V1
bunx wrangler secret put JWT_KID_CURRENT # value: v1
```

For local development, create a `.dev.vars` file:

```ini
JWT_SECRET_V1="your-local-dev-secret-at-least-32-chars-long"
JWT_KID_CURRENT="v1"
```

#### 4. Build and Deploy

```bash
# Build SPA frontend and worker bundle
bun run build

# Deploy to Cloudflare Workers
bun run deploy
```

Navigate to your Worker's URL to complete the initial admin setup.

---

## Quickstart: Install Agent

### Option A: One-line Shell Installer (Linux)

Run it and answer the prompts. The installer asks for the Hub URL (and checks it is reachable), the agent token (input hidden), the reporting interval and Docker monitoring, then installs the binary, verifies its SHA-256 checksum and sets up a `pantaw-agent` systemd service that starts on boot.

```bash
curl -sSL https://raw.githubusercontent.com/fadlee/pantaw/main/install-agent.sh | sudo bash
```

Non-interactive, for provisioning scripts:

```bash
curl -sSL https://raw.githubusercontent.com/fadlee/pantaw/main/install-agent.sh | sudo bash -s -- \
  --hub-url https://your-pantaw-hub.workers.dev \
  --token YOUR_AGENT_TOKEN \
  --yes
```

- **Upgrade:** run the installer again. It keeps the existing `/etc/pantaw/agent.env` (press Enter at each prompt) and restarts the service on the new binary.
- **Uninstall:** `curl -sSL https://raw.githubusercontent.com/fadlee/pantaw/main/install-agent.sh | sudo bash -s -- --uninstall`
- **All options:** `--help` (`--interval`, `--docker`/`--no-docker`, `--version`, `--no-service`).

### Option B: Docker Container

```bash
docker run -d \
  --name pantaw-agent \
  --restart unless-stopped \
  --net=host \
  --pid=host \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e HUB_URL=https://your-pantaw-hub.workers.dev \
  -e AGENT_TOKEN=YOUR_AGENT_TOKEN \
  -e INTERVAL=30 \
  -e DOCKER=true \
  ghcr.io/fadlee/pantaw-agent:latest
```

### Option C: Standalone Binary & Systemd

1. Download the pre-built binary for your OS/architecture from [Releases](https://github.com/fadlee/pantaw/releases).
2. Configure environment in `/etc/pantaw/agent.env`:
   ```env
   HUB_URL=https://your-pantaw-hub.workers.dev
   AGENT_TOKEN=YOUR_AGENT_TOKEN
   INTERVAL=30
   DOCKER=false
   LOG_LEVEL=info
   ```
3. Run as a systemd service:
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

---

## Agent Configuration Reference

| Environment Variable | Description | Default |
|---|---|---|
| `HUB_URL` | Base URL of your Pantaw Cloudflare Worker | *Required* |
| `AGENT_TOKEN` | System token generated from the Pantaw dashboard | *Required* |
| `INTERVAL` | Metric collection interval in seconds (minimum 5s) | `30` |
| `DOCKER` | Enable Docker container metrics via unix socket | `false` |
| `LOG_LEVEL` | Logger verbosity (`debug`, `info`, `warn`, `error`) | `info` |

---

## Resource Limits & Free Tier Fit

Pantaw is engineered to stay well within Cloudflare Workers Free Tier limits:

- **D1 Reads & Writes**: Ingest uses single batched INSERTs; host updates occur only once on first connection.
- **Workers KV Writes**: 0 KV writes on ingest. KV is strictly reserved for auth rate-limiting.
- **Ingest Rate Limiter**: 15 requests/minute per token bucket (accommodates intervals down to 5s with headroom).

---

## Development & Testing

```bash
# Run local dev server with Vite and Miniflare
bun run dev

# Run typecheck
bun run typecheck

# Run Biome lint & formatting check
bun run check

# Run Vitest test suite
bun run test

# Build and verify agent
cd agent && go test ./... && go build ./...
```

---

## Credits

Pantaw stands on the shoulders of **[Beszel](https://github.com/henrygd/beszel)** by [henrygd](https://github.com/henrygd).

- **Architecture:** Pantaw's agent–hub model is inspired by Beszel, reimplemented for the Cloudflare edge runtime (HTTPS ingest instead of an SSH tunnel, D1 instead of PocketBase). Pantaw is not a drop-in fork and its wire protocol is not Beszel-compatible.
- **Dashboard UI:** the React SPA is forked from [Beszel's web UI](https://github.com/henrygd/beszel/tree/main/internal/site), with the PocketBase layer replaced by Pantaw's Hono API. The translations in `src/client/locales` come from Beszel's community translators.

Beszel is released under the MIT License, Copyright (c) 2024 henrygd.

Pantaw is also built on these open-source projects:

- [Hono](https://hono.dev) — HTTP framework for the Worker
- [Valibot](https://valibot.dev) — shared request validation
- [gopsutil](https://github.com/shirou/gopsutil) — system metrics collection in the agent
- [Radix UI](https://www.radix-ui.com), [Tailwind CSS](https://tailwindcss.com), [Recharts](https://recharts.org), [TanStack](https://tanstack.com), and [Lingui](https://lingui.dev) — dashboard UI, charts, tables, and i18n

---

## License

MIT License. See [LICENSE](LICENSE) for details.
