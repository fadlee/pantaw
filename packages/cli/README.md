# pantaw

Deploy and upgrade a [Pantaw](https://github.com/fadlee/pantaw) server-monitoring hub on your own Cloudflare account — Workers, D1 and KV, all within the free tier.

```bash
bunx pantaw deploy        # or: npx pantaw deploy
```

The first run is a wizard: API token (the token page opens with the permissions pre-selected), D1 and KV provisioning, migrations, deploy, JWT secret, first admin account, and optionally your first server with its agent install command. Later runs upgrade the instance to the hub version bundled with the CLI, keeping all data.

| Command | What it does |
|---|---|
| `deploy [--name <instance>] [--yes]` | First deploy or upgrade |
| `status [--name <instance>]` | Show resources and probe health |
| `list` | List instances configured on this machine |
| `destroy [--name <instance>]` | Delete the Worker, D1 database and KV namespaces |

State lives in `~/.config/pantaw/<name>.json` (mode 600). Non-interactive use: `--yes` with `CLOUDFLARE_API_TOKEN`, optionally `CLOUDFLARE_ACCOUNT_ID`, `PANTAW_ADMIN_EMAIL` and `PANTAW_ADMIN_PASSWORD`.

The package version is the hub version it deploys: `bunx pantaw@0.4.0 deploy` deploys hub v0.4.0.

MIT licensed.
