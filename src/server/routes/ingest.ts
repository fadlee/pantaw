import { vValidator } from "@hono/valibot-validator"
import { Hono } from "hono"
import type { MetricsPayload } from "../../shared/schemas"
import { IngestBodySchema } from "../../shared/schemas"
import type { Env } from "../index"
import type { AgentAuthVars } from "../middleware/agent-auth"
import { agentAuth } from "../middleware/agent-auth"

/**
 * Window untuk validasi clock skew. Lihat RFC section 5 (clock skew) dan 6.
 * - past:   tidak boleh lebih dari 5 menit ke belakang
 * - future: tidak boleh lebih dari 1 menit ke depan
 */
const TS_PAST_WINDOW_S = 5 * 60
const TS_FUTURE_WINDOW_S = 60

/**
 * Field yang punya kolom dedicated di tabel metrics. Selain ini akan dipindah
 * ke kolom `extra` (JSON) supaya forward-compatible dengan field baru tanpa
 * perlu schema migration.
 */
const STORED_FIELDS = new Set([
	"ts",
	"cpu",
	"mem",
	"mem_used",
	"mem_total",
	"disk",
	"disk_read",
	"disk_write",
	"net_rx",
	"net_tx",
	"load",
	"temp",
])

const app = new Hono<{ Bindings: Env; Variables: AgentAuthVars }>()

app.post("/", agentAuth, vValidator("json", IngestBodySchema), async (c) => {
	// Rate limit per token (binding native Workers Rate Limiting)
	const tokenHash = c.get("tokenHash")
	const limit = await c.env.INGEST_LIMITER.limit({ key: tokenHash })
	if (!limit.success) {
		return c.json({ error: "rate_limited" }, 429, { "Retry-After": "60" })
	}

	const systemId = c.get("systemId")
	const body = c.req.valid("json")
	const payloads: MetricsPayload[] = Array.isArray(body) ? body : [body]

	if (payloads.length === 0) {
		return c.json({ error: "empty_payload" }, 400)
	}

	const nowSec = Math.floor(Date.now() / 1000)
	const minTs = nowSec - TS_PAST_WINDOW_S
	const maxTs = nowSec + TS_FUTURE_WINDOW_S

	// Validasi clock skew untuk semua item dulu, baru tulis ke DB. Mencegah
	// partial write kalau salah satu item rusak.
	for (const p of payloads) {
		if (p.ts < minTs || p.ts > maxTs) {
			return c.json(
				{
					error: "clock_skew",
					message: "ts out of allowed window; sync NTP on agent",
					ts: p.ts,
					now: nowSec,
				},
				400
			)
		}
	}

	// Build batch INSERT OR IGNORE statements. D1 prepare reuse: 1 query per row,
	// dijalankan dalam batch untuk minimalkan round-trip.
	const stmt = c.env.DB.prepare(
		`INSERT OR IGNORE INTO metrics
		 (system_id, ts, cpu, mem, mem_used, mem_total, disk, disk_read, disk_write,
		  net_rx, net_tx, load1, load5, load15, temp, extra)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)

	const batched = payloads.map((p) => {
		const extra: Record<string, unknown> = {}
		for (const [k, val] of Object.entries(p)) {
			if (!STORED_FIELDS.has(k) && val !== undefined) {
				extra[k] = val
			}
		}
		const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
		const load = p.load
		return stmt.bind(
			systemId,
			p.ts,
			p.cpu ?? null,
			p.mem ?? null,
			p.mem_used ?? null,
			p.mem_total ?? null,
			p.disk ?? null,
			p.disk_read ?? null,
			p.disk_write ?? null,
			p.net_rx ?? null,
			p.net_tx ?? null,
			load?.[0] ?? null,
			load?.[1] ?? null,
			load?.[2] ?? null,
			p.temp ?? null,
			extraJson
		)
	})

	await c.env.DB.batch(batched)

	// Cache: simpan payload terbaru saja (untuk dashboard latest read).
	// Pakai TTL 90s = window timeout default; kalau agent diam lebih lama,
	// cache miss otomatis = status dianggap stale di dashboard.
	const latest = payloads[payloads.length - 1]
	if (latest) {
		await c.env.CACHE_KV.put(`metrics:${systemId}:latest`, JSON.stringify(latest), {
			expirationTtl: 90,
		})
	}

	return c.body(null, 204)
})

export default app
