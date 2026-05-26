import { Hono } from "hono"
import ingest from "./routes/ingest"

export type Env = {
	DB: D1Database
	SESSION_KV: KVNamespace
	RATE_KV: KVNamespace
	CACHE_KV: KVNamespace
	INGEST_LIMITER: RateLimit
	JWT_SECRET_V1: string
	JWT_KID_CURRENT: string
	RETENTION_DAYS: string
	TIMEOUT_SECONDS: string
}

const app = new Hono<{ Bindings: Env }>()

app.get("/api/v1/health", (c) => c.json({ status: "ok", service: "pantaw" }))
app.route("/api/v1/ingest", ingest)

export type AppType = typeof app

export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
		// TODO: alert + status checker (cron */2 * * * *)
		// TODO: metrics cleanup (cron 0 2 * * *)
	},
} satisfies ExportedHandler<Env>
