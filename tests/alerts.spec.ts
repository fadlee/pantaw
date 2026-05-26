import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import worker from "../src/server/index"
import { sha256Hex } from "../src/server/lib/crypto"
import { hashPassword } from "../src/server/lib/password"

const ADMIN = {
	id: "user_admin",
	email: "admin@example.com",
	password: "admin-pass-very-strong",
}

const REGULAR = {
	id: "user_regular",
	email: "user@example.com",
	password: "user-pass-very-strong",
}

async function reset() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM alerts"),
		env.DB.prepare("DELETE FROM metrics"),
		env.DB.prepare("DELETE FROM agent_tokens"),
		env.DB.prepare("DELETE FROM systems"),
		env.DB.prepare("DELETE FROM users"),
	])
	const list = await env.RATE_KV.list({ prefix: "login:" })
	await Promise.all(list.keys.map((k) => env.RATE_KV.delete(k.name)))
}

async function setupUsers() {
	const now = Math.floor(Date.now() / 1000)
	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR REPLACE INTO users (id, email, password_hash, role, created_at, system_ids)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).bind(ADMIN.id, ADMIN.email, await hashPassword(ADMIN.password), "admin", now, "[]"),
		env.DB.prepare(
			`INSERT OR REPLACE INTO users (id, email, password_hash, role, created_at, system_ids)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).bind(REGULAR.id, REGULAR.email, await hashPassword(REGULAR.password), "user", now, "[]"),
	])
}

async function loginAs(opts: typeof ADMIN): Promise<string> {
	const res = await worker.fetch(
		new Request("http://test/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: opts.email, password: opts.password }),
		}),
		env
	)
	expect(res.status).toBe(200)
	return (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? ""
}

async function createSystem(name = "s1"): Promise<string> {
	const id = crypto.randomUUID()
	const tokenRaw = `tok-${crypto.randomUUID()}`
	const tokenHash = await sha256Hex(tokenRaw)
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		`INSERT INTO systems (id, name, host, agent_token_hash, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(id, name, "host", tokenHash, now, now)
		.run()
	return id
}

function jsonRequest(url: string, method: string, cookie: string, body?: unknown) {
	const init: RequestInit = {
		method,
		headers: {
			Cookie: cookie,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
	}
	if (body !== undefined) init.body = JSON.stringify(body)
	return new Request(url, init)
}

type AlertResp = {
	id: string
	system_id: string
	metric: string
	operator: string
	threshold: number
	duration_s: number
	enabled: boolean
	webhook_url: string | null
}

describe("/api/v1/alerts", () => {
	beforeEach(async () => {
		await reset()
		await setupUsers()
	})

	afterEach(async () => {
		await reset()
	})

	it("requires authentication", async () => {
		const res = await worker.fetch(new Request("http://test/api/v1/alerts"), env)
		expect(res.status).toBe(401)
	})

	it("admin can create alert with defaults", async () => {
		const cookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as AlertResp
		expect(body.system_id).toBe(sysId)
		expect(body.metric).toBe("cpu")
		expect(body.operator).toBe("gt")
		expect(body.threshold).toBe(80)
		expect(body.duration_s).toBe(60) // default
		expect(body.enabled).toBe(true) // default
		expect(body.webhook_url).toBeNull()
	})

	it("regular user cannot create alert", async () => {
		const cookie = await loginAs(REGULAR)
		const sysId = await createSystem()
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		expect(res.status).toBe(403)
	})

	it("rejects alert for unknown system", async () => {
		const cookie = await loginAs(ADMIN)
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: "does-not-exist",
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		expect(res.status).toBe(404)
	})

	it("validation: rejects unknown metric", async () => {
		const cookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "unknown",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		expect(res.status).toBe(400)
	})

	it("validation: rejects invalid webhook_url", async () => {
		const cookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
				webhook_url: "not-a-url",
			}),
			env
		)
		expect(res.status).toBe(400)
	})

	it("list returns all alerts; filter by system_id", async () => {
		const cookie = await loginAs(ADMIN)
		const a = await createSystem("a")
		const b = await createSystem("b")
		const make = (system_id: string, metric: string) =>
			worker.fetch(
				jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
					system_id,
					metric,
					operator: "gt",
					threshold: 50,
				}),
				env
			)
		await make(a, "cpu")
		await make(a, "mem")
		await make(b, "cpu")

		const all = await worker.fetch(jsonRequest("http://test/api/v1/alerts", "GET", cookie), env)
		expect(((await all.json()) as AlertResp[]).length).toBe(3)

		const filtered = await worker.fetch(
			jsonRequest(`http://test/api/v1/alerts?system_id=${a}`, "GET", cookie),
			env
		)
		const list = (await filtered.json()) as AlertResp[]
		expect(list.length).toBe(2)
		expect(list.every((x) => x.system_id === a)).toBe(true)
	})

	it("update partial: change threshold and enabled", async () => {
		const cookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		const createRes = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		const { id } = (await createRes.json()) as AlertResp

		const updateRes = await worker.fetch(
			jsonRequest(`http://test/api/v1/alerts/${id}`, "PUT", cookie, {
				threshold: 95,
				enabled: false,
			}),
			env
		)
		expect(updateRes.status).toBe(200)
		const updated = (await updateRes.json()) as AlertResp
		expect(updated.threshold).toBe(95)
		expect(updated.enabled).toBe(false)
		expect(updated.metric).toBe("cpu") // unchanged
	})

	it("update with empty body returns 400", async () => {
		const cookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		const create = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		const { id } = (await create.json()) as AlertResp

		const res = await worker.fetch(jsonRequest(`http://test/api/v1/alerts/${id}`, "PUT", cookie, {}), env)
		expect(res.status).toBe(400)
	})

	it("update returns 404 for unknown id", async () => {
		const cookie = await loginAs(ADMIN)
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts/missing", "PUT", cookie, { threshold: 99 }),
			env
		)
		expect(res.status).toBe(404)
	})

	it("delete removes alert", async () => {
		const cookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		const create = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		const { id } = (await create.json()) as AlertResp

		const res = await worker.fetch(jsonRequest(`http://test/api/v1/alerts/${id}`, "DELETE", cookie), env)
		expect(res.status).toBe(204)

		const list = await worker.fetch(jsonRequest("http://test/api/v1/alerts", "GET", cookie), env)
		expect(((await list.json()) as AlertResp[]).length).toBe(0)
	})

	it("regular user cannot delete alert", async () => {
		const adminCookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		const create = await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", adminCookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		const { id } = (await create.json()) as AlertResp

		const userCookie = await loginAs(REGULAR)
		const res = await worker.fetch(jsonRequest(`http://test/api/v1/alerts/${id}`, "DELETE", userCookie), env)
		expect(res.status).toBe(403)
	})

	it("alerts cascade-deleted when system is deleted", async () => {
		const cookie = await loginAs(ADMIN)
		const sysId = await createSystem()
		await worker.fetch(
			jsonRequest("http://test/api/v1/alerts", "POST", cookie, {
				system_id: sysId,
				metric: "cpu",
				operator: "gt",
				threshold: 80,
			}),
			env
		)
		await worker.fetch(jsonRequest(`http://test/api/v1/systems/${sysId}`, "DELETE", cookie), env)
		const left = await env.DB.prepare("SELECT COUNT(*) as n FROM alerts WHERE system_id = ?")
			.bind(sysId)
			.first<{ n: number }>()
		expect(left?.n).toBe(0)
	})
})
