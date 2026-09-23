import { Hono } from "hono"
import { runScheduled } from "./cron"
import { ensureSchema } from "./lib/schema"
import alerts from "./routes/alerts"
import auth from "./routes/auth"
import ingest from "./routes/ingest"
import systems from "./routes/systems"
export type Env = {
	DB: D1Database
	SESSION_KV: KVNamespace
	RATE_KV: KVNamespace
	INGEST_LIMITER: RateLimit
	JWT_SECRET_V1: string
	JWT_KID_CURRENT: string
	RETENTION_DAYS: string
	TIMEOUT_SECONDS: string
	/** Workers Static Assets binding — serve SPA bundle */
	ASSETS?: Fetcher
}

const app = new Hono<{ Bindings: Env }>()

/**
 * Auto-migration middleware: memastikan skema tabel D1 selalu terinisialisasi
 * secara otomatis saat worker pertama kali menangani request API.
 */
app.use("/api/*", async (c, next) => {
	if (c.env.DB) {
		await ensureSchema(c.env.DB)
	}
	await next()
})

/**
 * Health check endpoint. Tidak di-versioning karena bukan kontrak API
 * yang akan berubah. Aman dipakai untuk uptime monitoring eksternal.
 *
 * Mengembalikan status server dan basic dependency check (D1).
 */
const routes = app
	.get("/api/health", async (c) => {
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
	.get("/api/v1/health", (c) => c.redirect("/api/health", 301))
	.route("/api/v1/ingest", ingest)
	.route("/api/v1/auth", auth)
	.route("/api/v1/systems", systems)
	.route("/api/v1/alerts", alerts)
	// Catch-all: serve SPA untuk non-API routes (SPA behaviour saat refresh)
	// API routes yang tidak ada tetap return 404 JSON.
	.get("*", async (c) => {
		if (c.req.path.startsWith("/api/")) {
			return c.json({ error: "not_found" }, 404)
		}
		// ASSETS binding serve static files; jika tidak ada file,
		// not_found_handling = 'single-page-application' di wrangler.toml
		// otomatis serve index.html
		if (c.env.ASSETS) {
			return c.env.ASSETS.fetch(c.req.raw)
		}
		return c.json({ error: "not_found" }, 404)
	})

export type AppType = typeof routes

export default {
	fetch: app.fetch,
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			(async () => {
				if (env.DB) {
					await ensureSchema(env.DB)
				}
				await runScheduled(controller, env)
			})()
		)
	},
} satisfies ExportedHandler<Env>
