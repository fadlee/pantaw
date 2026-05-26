import { vValidator } from "@hono/valibot-validator"
import { Hono } from "hono"
import { CreateSystemBodySchema } from "../../shared/schemas"
import type { Env } from "../index"
import { sha256Hex } from "../lib/crypto"
import type { UserAuthVars } from "../middleware/user-auth"
import { requireAdmin, userAuth } from "../middleware/user-auth"

const app = new Hono<{ Bindings: Env; Variables: UserAuthVars }>()

// Semua route systems perlu auth user; admin-only diberlakukan per-route
app.use("*", userAuth)

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

/**
 * Hitung status real-time dari `last_seen` (= MAX(metrics.ts) per system).
 * Lihat RFC 4.2.
 */
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

/**
 * Generate raw API token: 32 random bytes → base64url (~43 chars).
 * Token mentah hanya ditampilkan sekali; D1 menyimpan SHA-256 hash-nya.
 */
function generateRawToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	let bin = ""
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const SELECT_WITH_LAST_SEEN = `s.id, s.name, s.host, s.timeout_seconds,
	s.last_status, s.last_status_at, s.created_at, s.updated_at, s.info,
	(SELECT MAX(ts) FROM metrics WHERE system_id = s.id) as last_seen`

// GET /api/v1/systems - list semua system
app.get("/", async (c) => {
	const nowSec = Math.floor(Date.now() / 1000)
	const { results } = await c.env.DB.prepare(
		`SELECT ${SELECT_WITH_LAST_SEEN} FROM systems s ORDER BY s.created_at DESC`
	).all<SystemListRow>()

	return c.json(results.map((row) => rowToResponse(row, nowSec)))
})

// POST /api/v1/systems - tambah system baru, return raw token (sekali tampil)
app.post("/", requireAdmin, vValidator("json", CreateSystemBodySchema), async (c) => {
	const body = c.req.valid("json")
	const id = crypto.randomUUID()
	const now = Math.floor(Date.now() / 1000)
	const timeoutSeconds = body.timeout_seconds ?? 90

	const rawToken = generateRawToken()
	const tokenHash = await sha256Hex(rawToken)
	const tokenId = crypto.randomUUID()

	try {
		await c.env.DB.batch([
			c.env.DB.prepare(
				`INSERT INTO systems (id, name, host, agent_token_hash, timeout_seconds, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			).bind(id, body.name, body.host, tokenHash, timeoutSeconds, now, now),
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
			host: body.host,
			timeout_seconds: timeoutSeconds,
			status: "unknown" as const,
			last_seen: null,
			info: null,
			created_at: now,
			updated_at: now,
			// Raw token hanya ditampilkan sekali. Setelah ini, server hanya
			// punya hash-nya saja. Pengguna wajib salin sekarang.
			agent_token: rawToken,
		},
		201
	)
})

// GET /api/v1/systems/:id - detail satu system
app.get("/:id", async (c) => {
	const id = c.req.param("id")
	const nowSec = Math.floor(Date.now() / 1000)
	const row = await c.env.DB.prepare(`SELECT ${SELECT_WITH_LAST_SEEN} FROM systems s WHERE s.id = ? LIMIT 1`)
		.bind(id)
		.first<SystemListRow>()

	if (!row) return c.json({ error: "not_found" }, 404)
	return c.json(rowToResponse(row, nowSec))
})

// DELETE /api/v1/systems/:id - hapus system (cascade ke metrics + tokens)
app.delete("/:id", requireAdmin, async (c) => {
	const id = c.req.param("id")
	const result = await c.env.DB.prepare("DELETE FROM systems WHERE id = ?").bind(id).run()
	if (result.meta.changes === 0) {
		return c.json({ error: "not_found" }, 404)
	}
	return c.body(null, 204)
})

// POST /api/v1/systems/:id/tokens - generate token agent baru (rotation)
app.post("/:id/tokens", requireAdmin, async (c) => {
	const id = c.req.param("id")
	const exists = await c.env.DB.prepare("SELECT 1 FROM systems WHERE id = ?").bind(id).first()
	if (!exists) return c.json({ error: "not_found" }, 404)

	const rawToken = generateRawToken()
	const tokenHash = await sha256Hex(rawToken)
	const tokenId = crypto.randomUUID()
	const now = Math.floor(Date.now() / 1000)

	await c.env.DB.prepare(
		`INSERT INTO agent_tokens (id, system_id, token_hash, label, created_at)
		 VALUES (?, ?, ?, ?, ?)`
	)
		.bind(tokenId, id, tokenHash, "rotated", now)
		.run()

	return c.json({ id: tokenId, agent_token: rawToken, created_at: now }, 201)
})

export default app
