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

async function createUser(opts: typeof ADMIN, role: "admin" | "user") {
	const hash = await hashPassword(opts.password)
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		`INSERT OR REPLACE INTO users (id, email, password_hash, role, created_at, system_ids)
		 VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(opts.id, opts.email, hash, role, now, "[]")
		.run()
}

async function reset() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM metrics"),
		env.DB.prepare("DELETE FROM agent_tokens"),
		env.DB.prepare("DELETE FROM systems"),
		env.DB.prepare("DELETE FROM users"),
	])
	const list = await env.RATE_KV.list({ prefix: "login:" })
	await Promise.all(list.keys.map((k) => env.RATE_KV.delete(k.name)))
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
	const setCookie = res.headers.get("Set-Cookie") ?? ""
	return setCookie.split(";")[0] ?? ""
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

describe("/api/v1/systems", () => {
	beforeEach(async () => {
		await reset()
		await createUser(ADMIN, "admin")
		await createUser(REGULAR, "user")
	})

	afterEach(async () => {
		await reset()
	})

	it("requires authentication for list", async () => {
		const res = await worker.fetch(new Request("http://test/api/v1/systems"), env)
		expect(res.status).toBe(401)
	})

	it("admin can create a system and gets raw token once", async () => {
		const cookie = await loginAs(ADMIN)
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, {
				name: "server-1",
				host: "192.168.1.10",
			}),
			env
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as {
			id: string
			name: string
			host: string
			status: string
			agent_token: string
		}
		expect(body.name).toBe("server-1")
		expect(body.host).toBe("192.168.1.10")
		expect(body.status).toBe("unknown")
		expect(body.agent_token).toMatch(/^[A-Za-z0-9_-]{40,}$/)

		// Token mentah TIDAK disimpan; yang disimpan adalah hash
		const expectedHash = await sha256Hex(body.agent_token)
		const row = await env.DB.prepare("SELECT token_hash FROM agent_tokens WHERE system_id = ? LIMIT 1")
			.bind(body.id)
			.first<{ token_hash: string }>()
		expect(row?.token_hash).toBe(expectedHash)
	})

	it("regular user cannot create system", async () => {
		const cookie = await loginAs(REGULAR)
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, {
				name: "server-1",
				host: "host",
			}),
			env
		)
		expect(res.status).toBe(403)
	})

	it("rejects duplicate system name", async () => {
		const cookie = await loginAs(ADMIN)
		const body = { name: "dup", host: "host" }
		const first = await worker.fetch(jsonRequest("http://test/api/v1/systems", "POST", cookie, body), env)
		expect(first.status).toBe(201)
		const second = await worker.fetch(jsonRequest("http://test/api/v1/systems", "POST", cookie, body), env)
		expect(second.status).toBe(409)
	})

	it("created token works against /api/v1/ingest", async () => {
		const cookie = await loginAs(ADMIN)
		const createRes = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, {
				name: "s-ingest",
				host: "host",
			}),
			env
		)
		const created = (await createRes.json()) as { agent_token: string }

		const ingestRes = await worker.fetch(
			new Request("http://test/api/v1/ingest", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${created.agent_token}`,
				},
				body: JSON.stringify({
					ts: Math.floor(Date.now() / 1000),
					cpu: 5,
					mem: 10,
				}),
			}),
			env
		)
		expect(ingestRes.status).toBe(204)
	})

	it("list returns systems with computed status (up if recent metric, down if stale)", async () => {
		const cookie = await loginAs(ADMIN)
		// Sistem A dengan metric baru
		const aRes = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, { name: "a", host: "h-a" }),
			env
		)
		const a = (await aRes.json()) as { id: string; agent_token: string }

		await worker.fetch(
			new Request("http://test/api/v1/ingest", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${a.agent_token}`,
				},
				body: JSON.stringify({ ts: Math.floor(Date.now() / 1000), cpu: 1, mem: 1 }),
			}),
			env
		)

		// Sistem B tanpa metric
		await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, { name: "b", host: "h-b" }),
			env
		)

		const listRes = await worker.fetch(jsonRequest("http://test/api/v1/systems", "GET", cookie), env)
		expect(listRes.status).toBe(200)
		const list = (await listRes.json()) as { name: string; status: string; last_seen: number | null }[]
		const byName = Object.fromEntries(list.map((s) => [s.name, s]))
		expect(byName.a?.status).toBe("up")
		expect(byName.a?.last_seen).toBeTypeOf("number")
		expect(byName.b?.status).toBe("unknown")
		expect(byName.b?.last_seen).toBeNull()
	})

	it("get returns 404 for unknown id", async () => {
		const cookie = await loginAs(ADMIN)
		const res = await worker.fetch(jsonRequest("http://test/api/v1/systems/does-not-exist", "GET", cookie), env)
		expect(res.status).toBe(404)
	})

	it("delete cascades metrics and tokens", async () => {
		const cookie = await loginAs(ADMIN)
		const createRes = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, { name: "to-del", host: "h" }),
			env
		)
		const created = (await createRes.json()) as { id: string; agent_token: string }

		await worker.fetch(
			new Request("http://test/api/v1/ingest", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${created.agent_token}`,
				},
				body: JSON.stringify({ ts: Math.floor(Date.now() / 1000), cpu: 1, mem: 1 }),
			}),
			env
		)

		const delRes = await worker.fetch(
			jsonRequest(`http://test/api/v1/systems/${created.id}`, "DELETE", cookie),
			env
		)
		expect(delRes.status).toBe(204)

		const metricsLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM metrics WHERE system_id = ?")
			.bind(created.id)
			.first<{ n: number }>()
		const tokensLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM agent_tokens WHERE system_id = ?")
			.bind(created.id)
			.first<{ n: number }>()
		expect(metricsLeft?.n).toBe(0)
		expect(tokensLeft?.n).toBe(0)
	})

	it("regular user cannot delete", async () => {
		const adminCookie = await loginAs(ADMIN)
		const created = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", adminCookie, { name: "x", host: "h" }),
			env
		)
		const { id } = (await created.json()) as { id: string }

		const userCookie = await loginAs(REGULAR)
		const res = await worker.fetch(jsonRequest(`http://test/api/v1/systems/${id}`, "DELETE", userCookie), env)
		expect(res.status).toBe(403)
	})

	it("admin can rotate token; old + new both work until old removed", async () => {
		const cookie = await loginAs(ADMIN)
		const createRes = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, { name: "rot", host: "h" }),
			env
		)
		const { id, agent_token: oldToken } = (await createRes.json()) as {
			id: string
			agent_token: string
		}

		const rotRes = await worker.fetch(
			jsonRequest(`http://test/api/v1/systems/${id}/tokens`, "POST", cookie),
			env
		)
		expect(rotRes.status).toBe(201)
		const { agent_token: newToken } = (await rotRes.json()) as { agent_token: string }
		expect(newToken).not.toBe(oldToken)

		// Both tokens berhasil ingest (rate limiter per token, jadi tidak bentrok)
		for (const token of [oldToken, newToken]) {
			const res = await worker.fetch(
				new Request("http://test/api/v1/ingest", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						ts: Math.floor(Date.now() / 1000) - (token === oldToken ? 1 : 0),
						cpu: 1,
						mem: 1,
					}),
				}),
				env
			)
			expect(res.status).toBe(204)
		}
	})

	it("validation: rejects empty name", async () => {
		const cookie = await loginAs(ADMIN)
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, { name: "", host: "h" }),
			env
		)
		expect(res.status).toBe(400)
	})

	it("validation: timeout_seconds must be in range", async () => {
		const cookie = await loginAs(ADMIN)
		const res = await worker.fetch(
			jsonRequest("http://test/api/v1/systems", "POST", cookie, {
				name: "t1",
				host: "h",
				timeout_seconds: 5, // < 30
			}),
			env
		)
		expect(res.status).toBe(400)
	})
})
