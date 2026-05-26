import { Hono } from "hono"
import alerts from "./routes/alerts"
import auth from "./routes/auth"
import ingest from "./routes/ingest"
import systems from "./routes/systems"

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

/**
 * Health check endpoint. Tidak di-versioning karena bukan kontrak API
 * yang akan berubah. Aman dipakai untuk uptime monitoring eksternal.
 *
 * Mengembalikan status server dan basic dependency check (D1).
 */
app.get("/api/health", async (c) => {
	const startedAt = Date.now()
	let dbOk = false
	try {
		const row = await c.env.DB.prepare("SELECT 1 as ok").first<{ ok: number }>()
		dbOk = row?.ok === 1
	} catch {
		dbOk = false
	}
	return c.json(
		{
			status: dbOk ? "ok" : "degraded",
			service: "pantaw",
			timestamp: new Date().toISOString(),
			checks: {
				db: dbOk,
			},
			latency_ms: Date.now() - startedAt,
		},
		dbOk ? 200 : 503
	)
})

// Alias /v1/ untuk backward-compat dengan client lama yang sudah pakai
// versi-prefixed path. Bisa dihapus saat tidak ada konsumen.
app.get("/api/v1/health", (c) => c.redirect("/api/health", 301))

app.route("/api/v1/ingest", ingest)
app.route("/api/v1/auth", auth)
app.route("/api/v1/systems", systems)
app.route("/api/v1/alerts", alerts)

export type AppType = typeof app

export default {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
		// TODO: alert + status checker (cron */2 * * * *)
		// TODO: metrics cleanup (cron 0 2 * * *)
	},
} satisfies ExportedHandler<Env>
