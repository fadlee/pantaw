import { vValidator } from "@hono/valibot-validator"
import { Hono } from "hono"
import { CreateAlertBodySchema, UpdateAlertBodySchema } from "../../shared/schemas"
import type { Env } from "../index"
import type { UserAuthVars } from "../middleware/user-auth"
import { scopeSystems, userAuth } from "../middleware/user-auth"
type AlertRow = {
	id: string
	system_id: string
	metric: string
	threshold: number
	operator: string
	duration_s: number
	enabled: number
	webhook_url: string | null
	last_fired: number | null
}

function rowToResponse(row: AlertRow) {
	return {
		id: row.id,
		system_id: row.system_id,
		metric: row.metric,
		operator: row.operator,
		threshold: row.threshold,
		duration_s: row.duration_s,
		enabled: row.enabled === 1,
		webhook_url: row.webhook_url,
		last_fired: row.last_fired,
	}
}

const app = new Hono<{ Bindings: Env; Variables: UserAuthVars }>()
	.use("*", userAuth)
	.get("/", async (c) => {
		const systemId = c.req.query("system_id")
		const { isAdmin, allowedIds } = scopeSystems(c)
		const boundedIds = allowedIds.slice(0, 100)

		if (!isAdmin && boundedIds.length === 0) {
			return c.json([])
		}

		if (systemId) {
			if (!isAdmin && !allowedIds.includes(systemId)) {
				return c.json([])
			}
			const stmt = c.env.DB.prepare("SELECT * FROM alerts WHERE system_id = ? ORDER BY id").bind(systemId)
			const { results } = await stmt.all<AlertRow>()
			return c.json(results.map(rowToResponse))
		}

		let sql = "SELECT * FROM alerts"
		const params: unknown[] = []
		if (!isAdmin) {
			const placeholders = boundedIds.map(() => "?").join(", ")
			sql += ` WHERE system_id IN (${placeholders})`
			params.push(...boundedIds)
		}
		sql += " ORDER BY system_id, id"

		const stmt = c.env.DB.prepare(sql)
		const bound = params.length > 0 ? stmt.bind(...params) : stmt
		const { results } = await bound.all<AlertRow>()
		return c.json(results.map(rowToResponse))
	})
	.post("/", vValidator("json", CreateAlertBodySchema), async (c) => {
		const body = c.req.valid("json")
		const { isAdmin, allowedIds } = scopeSystems(c)
		if (!isAdmin && !allowedIds.includes(body.system_id)) {
			return c.json({ error: "system_not_found" }, 404)
		}
		const exists = await c.env.DB.prepare("SELECT 1 FROM systems WHERE id = ?").bind(body.system_id).first()
		if (!exists) return c.json({ error: "system_not_found" }, 404)
		const id = crypto.randomUUID()
		const enabled = body.enabled === false ? 0 : 1
		const durationS = body.duration_s ?? 60
		await c.env.DB.prepare(
			`INSERT INTO alerts (id, system_id, metric, threshold, operator, duration_s, enabled, webhook_url)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				id,
				body.system_id,
				body.metric,
				body.threshold,
				body.operator,
				durationS,
				enabled,
				body.webhook_url ?? null
			)
			.run()
		const row = await c.env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(id).first<AlertRow>()
		if (!row) return c.json({ error: "create_failed" }, 500)
		return c.json(rowToResponse(row), 201)
	})
	.put("/:id", vValidator("json", UpdateAlertBodySchema), async (c) => {
		const id = c.req.param("id")
		const existing = await c.env.DB.prepare("SELECT system_id FROM alerts WHERE id = ?")
			.bind(id)
			.first<{ system_id: string }>()
		if (!existing) return c.json({ error: "not_found" }, 404)
		const { isAdmin, allowedIds } = scopeSystems(c)
		if (!isAdmin && !allowedIds.includes(existing.system_id)) {
			return c.json({ error: "not_found" }, 404)
		}
		const body = c.req.valid("json")
		const updates: string[] = []
		const values: (string | number | null)[] = []
		if (body.metric !== undefined) {
			updates.push("metric = ?")
			values.push(body.metric)
		}
		if (body.operator !== undefined) {
			updates.push("operator = ?")
			values.push(body.operator)
		}
		if (body.threshold !== undefined) {
			updates.push("threshold = ?")
			values.push(body.threshold)
		}
		if (body.duration_s !== undefined) {
			updates.push("duration_s = ?")
			values.push(body.duration_s)
		}
		if (body.enabled !== undefined) {
			updates.push("enabled = ?")
			values.push(body.enabled ? 1 : 0)
		}
		if (body.webhook_url !== undefined) {
			updates.push("webhook_url = ?")
			values.push(body.webhook_url)
		}
		if (updates.length === 0) return c.json({ error: "no_fields_to_update" }, 400)
		values.push(id)
		const result = await c.env.DB.prepare(`UPDATE alerts SET ${updates.join(", ")} WHERE id = ?`)
			.bind(...values)
			.run()
		if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404)
		const row = await c.env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(id).first<AlertRow>()
		if (!row) return c.json({ error: "not_found" }, 404)
		return c.json(rowToResponse(row))
	})
	.delete("/:id", async (c) => {
		const id = c.req.param("id")
		const existing = await c.env.DB.prepare("SELECT system_id FROM alerts WHERE id = ?")
			.bind(id)
			.first<{ system_id: string }>()
		if (!existing) return c.json({ error: "not_found" }, 404)
		const { isAdmin, allowedIds } = scopeSystems(c)
		if (!isAdmin && !allowedIds.includes(existing.system_id)) {
			return c.json({ error: "not_found" }, 404)
		}
		const result = await c.env.DB.prepare("DELETE FROM alerts WHERE id = ?").bind(id).run()
		if (result.meta.changes === 0) return c.json({ error: "not_found" }, 404)
		return c.body(null, 204)
	})

export default app
