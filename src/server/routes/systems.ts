import { vValidator } from "@hono/valibot-validator"
import { Hono } from "hono"
import { CreateSystemBodySchema, MetricsQuerySchema } from "../../shared/schemas"
import type { Env } from "../index"
import { sha256Hex } from "../lib/crypto"
import type { UserAuthVars } from "../middleware/user-auth"
import { requireAdmin, scopeSystems, userAuth } from "../middleware/user-auth"

type SystemListRow = {
	id: string
	name: string
	host: string
	timeout_seconds: number
	last_status: string
	last_status_at: number | null
	created_at: number
	updated_at: number
	info: string | null
	last_seen: number | null
}

function computeStatus(
	lastSeen: number | null,
	timeoutSeconds: number,
	nowSec: number
): "up" | "down" | "unknown" {
	if (lastSeen === null) return "unknown"
	return nowSec - lastSeen < timeoutSeconds ? "up" : "down"
}

function rowToResponse(row: SystemListRow, nowSec: number) {
	return {
		id: row.id,
		name: row.name,
		host: row.host,
		timeout_seconds: row.timeout_seconds,
		status: computeStatus(row.last_seen, row.timeout_seconds, nowSec),
		last_seen: row.last_seen,
		info: row.info ? (JSON.parse(row.info) as unknown) : null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

function generateRawToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	let bin = ""
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const SELECT_WITH_LAST_SEEN = `s.id, s.name, s.host, s.timeout_seconds,
	s.last_status, s.last_status_at, s.created_at, s.updated_at, s.info,
	(SELECT MAX(ts) FROM metrics WHERE system_id = s.id) as last_seen`

const RAW_METRIC_COLUMNS = [
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
	"load1",
	"load5",
	"load15",
	"temp",
] as const

const app = new Hono<{ Bindings: Env; Variables: UserAuthVars }>()
	.use("*", userAuth)
	.get("/", async (c) => {
		const nowSec = Math.floor(Date.now() / 1000)
		const { isAdmin, allowedIds } = scopeSystems(c)
		const boundedIds = allowedIds.slice(0, 100)
		if (!isAdmin && boundedIds.length === 0) {
			return c.json([])
		}

		let sql = `SELECT ${SELECT_WITH_LAST_SEEN} FROM systems s`
		const params: unknown[] = []
		if (!isAdmin) {
			const placeholders = boundedIds.map(() => "?").join(", ")
			sql += ` WHERE s.id IN (${placeholders})`
			params.push(...boundedIds)
		}
		sql += " ORDER BY s.created_at DESC"

		const stmt = c.env.DB.prepare(sql)
		const bound = params.length > 0 ? stmt.bind(...params) : stmt
		const { results } = await bound.all<SystemListRow>()
		return c.json(results.map((row) => rowToResponse(row, nowSec)))
	})
	.post("/", requireAdmin, vValidator("json", CreateSystemBodySchema), async (c) => {
		const body = c.req.valid("json")
		const id = crypto.randomUUID()
		const now = Math.floor(Date.now() / 1000)
		const timeoutSeconds = body.timeout_seconds ?? 90
		const host = body.host ?? ""
		const rawToken = generateRawToken()
		const tokenHash = await sha256Hex(rawToken)
		const tokenId = crypto.randomUUID()
		try {
			await c.env.DB.batch([
				c.env.DB.prepare(
					`INSERT INTO systems (id, name, host, agent_token_hash, timeout_seconds, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				).bind(id, body.name, host, tokenHash, timeoutSeconds, now, now),
				c.env.DB.prepare(
					`INSERT INTO agent_tokens (id, system_id, token_hash, label, created_at)
					 VALUES (?, ?, ?, ?, ?)`
				).bind(tokenId, id, tokenHash, "initial", now),
			])
		} catch (err) {
			if (err instanceof Error && /UNIQUE/i.test(err.message)) {
				return c.json({ error: "name_taken" }, 409)
			}
			throw err
		}
		return c.json(
			{
				id,
				name: body.name,
				host,
				timeout_seconds: timeoutSeconds,
				status: "unknown" as const,
				last_seen: null,
				info: null,
				created_at: now,
				updated_at: now,
				agent_token: rawToken,
			},
			201
		)
	})
	.get("/:id", async (c) => {
		const id = c.req.param("id")
		const { isAdmin, allowedIds } = scopeSystems(c)
		if (!isAdmin && !allowedIds.includes(id)) {
			return c.json({ error: "not_found" }, 404)
		}
		const nowSec = Math.floor(Date.now() / 1000)
		const row = await c.env.DB.prepare(`SELECT ${SELECT_WITH_LAST_SEEN} FROM systems s WHERE s.id = ? LIMIT 1`)
			.bind(id)
			.first<SystemListRow>()
		if (!row) return c.json({ error: "not_found" }, 404)
		return c.json(rowToResponse(row, nowSec))
	})
	.delete("/:id", requireAdmin, async (c) => {
		const id = c.req.param("id")
		const result = await c.env.DB.prepare("DELETE FROM systems WHERE id = ?").bind(id).run()
		if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404)
		return c.body(null, 204)
	})
	.get("/:id/tokens", requireAdmin, async (c) => {
		const id = c.req.param("id")
		const exists = await c.env.DB.prepare("SELECT 1 FROM systems WHERE id = ?").bind(id).first()
		if (!exists) return c.json({ error: "not_found" }, 404)
		const { results } = await c.env.DB.prepare(
			"SELECT id, label, created_at, last_used FROM agent_tokens WHERE system_id = ? ORDER BY created_at DESC"
		)
			.bind(id)
			.all()
		return c.json(results)
	})
	.post("/:id/tokens", requireAdmin, async (c) => {
		const id = c.req.param("id")
		const exists = await c.env.DB.prepare("SELECT 1 FROM systems WHERE id = ?").bind(id).first()
		if (!exists) return c.json({ error: "not_found" }, 404)
		const rawToken = generateRawToken()
		const tokenHash = await sha256Hex(rawToken)
		const tokenId = crypto.randomUUID()
		const now = Math.floor(Date.now() / 1000)
		const revokeOthers = c.req.query("revoke_others") === "true"
		const insertTokenStmt = c.env.DB.prepare(
			"INSERT INTO agent_tokens (id, system_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)"
		).bind(tokenId, id, tokenHash, revokeOthers ? "rotated" : "additional", now)

		if (revokeOthers) {
			const deleteTokensStmt = c.env.DB.prepare("DELETE FROM agent_tokens WHERE system_id = ?").bind(id)
			const updateSystemHashStmt = c.env.DB.prepare(
				"UPDATE systems SET agent_token_hash = ?, updated_at = ? WHERE id = ?"
			).bind(tokenHash, now, id)
			await c.env.DB.batch([deleteTokensStmt, insertTokenStmt, updateSystemHashStmt])
		} else {
			await insertTokenStmt.run()
		}

		return c.json({ id: tokenId, agent_token: rawToken, created_at: now }, 201)
	})
	.delete("/:id/tokens/:tokenId", requireAdmin, async (c) => {
		const id = c.req.param("id")
		const tokenId = c.req.param("tokenId")
		const countRow = await c.env.DB.prepare("SELECT COUNT(*) as count FROM agent_tokens WHERE system_id = ?")
			.bind(id)
			.first<{ count: number }>()

		if ((countRow?.count ?? 0) <= 1) {
			return c.json({ error: "cannot_delete_last_token" }, 400)
		}

		const result = await c.env.DB.prepare("DELETE FROM agent_tokens WHERE id = ? AND system_id = ?")
			.bind(tokenId, id)
			.run()

		if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404)
		return c.body(null, 204)
	})
	.get("/:id/metrics", vValidator("query", MetricsQuerySchema), async (c) => {
		const id = c.req.param("id")
		const { isAdmin, allowedIds } = scopeSystems(c)
		if (!isAdmin && !allowedIds.includes(id)) {
			return c.json({ error: "not_found" }, 404)
		}
		const { from, to, bucket, limit } = c.req.valid("query")
		const exists = await c.env.DB.prepare("SELECT 1 FROM systems WHERE id = ?").bind(id).first()
		if (!exists) return c.json({ error: "not_found" }, 404)
		const nowSec = Math.floor(Date.now() / 1000)
		const toTs = to ?? nowSec
		const fromTs = from ?? toTs - 60 * 60
		if (fromTs >= toTs) return c.json({ error: "invalid_range", message: "from must be < to" }, 400)
		const rowLimit = limit ?? 500
		if (bucket) {
			const { results } = await c.env.DB.prepare(
				`SELECT (ts - (ts % CAST(? AS INTEGER))) AS bucket_ts,
				        AVG(cpu) AS cpu, AVG(mem) AS mem,
				        AVG(mem_used) AS mem_used, AVG(mem_total) AS mem_total,
				        AVG(disk) AS disk, AVG(disk_read) AS disk_read, AVG(disk_write) AS disk_write,
				        AVG(net_rx) AS net_rx, AVG(net_tx) AS net_tx,
				        AVG(load1) AS load1, AVG(load5) AS load5, AVG(load15) AS load15,
				        AVG(temp) AS temp, COUNT(*) AS samples
				 FROM metrics WHERE system_id = ? AND ts >= ? AND ts < ?
				 GROUP BY bucket_ts ORDER BY bucket_ts ASC LIMIT ?`
			)
				.bind(bucket, id, fromTs, toTs, rowLimit)
				.all<Record<string, number>>()
			return c.json({
				range: { from: fromTs, to: toTs },
				bucket,
				count: results.length,
				data: results.map((r) => ({
					ts: r.bucket_ts,
					cpu: r.cpu,
					mem: r.mem,
					mem_used: r.mem_used,
					mem_total: r.mem_total,
					disk: r.disk,
					disk_read: r.disk_read,
					disk_write: r.disk_write,
					net_rx: r.net_rx,
					net_tx: r.net_tx,
					load1: r.load1,
					load5: r.load5,
					load15: r.load15,
					temp: r.temp,
					samples: r.samples,
				})),
			})
		}
		const { results } = await c.env.DB.prepare(
			`SELECT ${RAW_METRIC_COLUMNS.join(", ")}, extra
			 FROM metrics WHERE system_id = ? AND ts >= ? AND ts < ?
			 ORDER BY ts ASC LIMIT ?`
		)
			.bind(id, fromTs, toTs, rowLimit)
			.all<Record<string, unknown>>()
		return c.json({
			range: { from: fromTs, to: toTs },
			bucket: null,
			count: results.length,
			data: results.map((r) => {
				const extraRaw = typeof r.extra === "string" ? r.extra : null
				const extra = extraRaw ? (JSON.parse(extraRaw) as unknown) : null
				const { extra: _drop, ...rest } = r
				void _drop
				return { ...rest, extra }
			}),
		})
	})

export default app
