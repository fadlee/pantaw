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

async function setup() {
	const hash = await hashPassword(ADMIN.password)
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		`INSERT OR REPLACE INTO users (id, email, password_hash, role, created_at, system_ids)
		 VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(ADMIN.id, ADMIN.email, hash, "admin", now, "[]")
		.run()
}

async function loginAdmin(): Promise<string> {
	const res = await worker.fetch(
		new Request("http://test/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
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
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO systems (id, name, host, agent_token_hash, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).bind(id, name, "host", tokenHash, now, now),
		env.DB.prepare(
			`INSERT INTO agent_tokens (id, system_id, token_hash, created_at)
			 VALUES (?, ?, ?, ?)`
		).bind(`t-${crypto.randomUUID()}`, id, tokenHash, now),
	])
	return id
}

async function insertMetrics(systemId: string, samples: { ts: number; cpu: number; mem: number }[]) {
	const stmt = env.DB.prepare("INSERT OR IGNORE INTO metrics (system_id, ts, cpu, mem) VALUES (?, ?, ?, ?)")
	await env.DB.batch(samples.map((s) => stmt.bind(systemId, s.ts, s.cpu, s.mem)))
}

describe("/api/v1/systems/:id/metrics", () => {
	beforeEach(async () => {
		await reset()
		await setup()
	})

	afterEach(async () => {
		await reset()
	})

	it("requires authentication", async () => {
		const res = await worker.fetch(new Request("http://test/api/v1/systems/abc/metrics"), env)
		expect(res.status).toBe(401)
	})

	it("returns 404 for unknown system", async () => {
		const cookie = await loginAdmin()
		const res = await worker.fetch(
			new Request("http://test/api/v1/systems/does-not-exist/metrics", {
				headers: { Cookie: cookie },
			}),
			env
		)
		expect(res.status).toBe(404)
	})

	it("returns raw rows in ASC order with default 1h window", async () => {
		const cookie = await loginAdmin()
		const id = await createSystem()
		const now = Math.floor(Date.now() / 1000)
		await insertMetrics(id, [
			{ ts: now - 50 * 60, cpu: 10, mem: 20 },
			{ ts: now - 30 * 60, cpu: 30, mem: 40 },
			{ ts: now - 10 * 60, cpu: 50, mem: 60 },
		])

		const res = await worker.fetch(
			new Request(`http://test/api/v1/systems/${id}/metrics`, {
				headers: { Cookie: cookie },
			}),
			env
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			count: number
			bucket: number | null
			data: { ts: number; cpu: number; mem: number; extra: unknown }[]
		}
		expect(body.bucket).toBeNull()
		expect(body.count).toBe(3)
		expect(body.data.map((d) => d.cpu)).toEqual([10, 30, 50])
	})

	it("respects from and to time range", async () => {
		const cookie = await loginAdmin()
		const id = await createSystem()
		const now = Math.floor(Date.now() / 1000)
		await insertMetrics(id, [
			{ ts: now - 7200, cpu: 1, mem: 1 },
			{ ts: now - 1800, cpu: 2, mem: 2 },
			{ ts: now - 300, cpu: 3, mem: 3 },
		])

		const from = now - 3600
		const to = now
		const res = await worker.fetch(
			new Request(`http://test/api/v1/systems/${id}/metrics?from=${from}&to=${to}`, {
				headers: { Cookie: cookie },
			}),
			env
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { count: number; data: { cpu: number }[] }
		expect(body.count).toBe(2)
		expect(body.data.map((d) => d.cpu)).toEqual([2, 3])
	})

	it("rejects invalid range (from >= to)", async () => {
		const cookie = await loginAdmin()
		const id = await createSystem()
		const res = await worker.fetch(
			new Request(`http://test/api/v1/systems/${id}/metrics?from=200&to=100`, {
				headers: { Cookie: cookie },
			}),
			env
		)
		expect(res.status).toBe(400)
	})

	it("aggregates with bucket parameter (AVG per bucket)", async () => {
		const cookie = await loginAdmin()
		const id = await createSystem()
		// Base timestamp aligned ke 60 (1700000040 % 60 == 0) untuk bucket
		// alignment yang deterministic.
		const base = 1_700_000_040
		// 4 sample dalam 60-detik window pertama, 2 sample di window kedua
		await insertMetrics(id, [
			{ ts: base + 0, cpu: 10, mem: 0 },
			{ ts: base + 15, cpu: 20, mem: 0 },
			{ ts: base + 30, cpu: 30, mem: 0 },
			{ ts: base + 45, cpu: 40, mem: 0 },
			{ ts: base + 60, cpu: 80, mem: 0 },
			{ ts: base + 90, cpu: 100, mem: 0 },
		])

		const from = base
		const to = base + 120
		const res = await worker.fetch(
			new Request(`http://test/api/v1/systems/${id}/metrics?from=${from}&to=${to}&bucket=60`, {
				headers: { Cookie: cookie },
			}),
			env
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			bucket: number
			count: number
			data: { ts: number; cpu: number; samples: number }[]
		}
		expect(body.bucket).toBe(60)
		expect(body.count).toBe(2)
		expect(body.data[0]?.ts).toBe(base)
		expect(body.data[0]?.cpu).toBe(25) // (10+20+30+40)/4
		expect(body.data[0]?.samples).toBe(4)
		expect(body.data[1]?.ts).toBe(base + 60)
		expect(body.data[1]?.cpu).toBe(90) // (80+100)/2
		expect(body.data[1]?.samples).toBe(2)
	})

	it("respects limit parameter", async () => {
		const cookie = await loginAdmin()
		const id = await createSystem()
		const now = Math.floor(Date.now() / 1000)
		const samples = Array.from({ length: 10 }, (_, i) => ({
			ts: now - 60 + i,
			cpu: i,
			mem: i,
		}))
		await insertMetrics(id, samples)

		const res = await worker.fetch(
			new Request(`http://test/api/v1/systems/${id}/metrics?limit=3`, {
				headers: { Cookie: cookie },
			}),
			env
		)
		const body = (await res.json()) as { count: number }
		expect(body.count).toBe(3)
	})

	it("validation: rejects bucket out of range", async () => {
		const cookie = await loginAdmin()
		const id = await createSystem()
		const res = await worker.fetch(
			new Request(`http://test/api/v1/systems/${id}/metrics?bucket=10`, {
				headers: { Cookie: cookie },
			}),
			env
		)
		expect(res.status).toBe(400)
	})

	it("includes extra JSON column parsed as object", async () => {
		const cookie = await loginAdmin()
		const id = await createSystem()
		const now = Math.floor(Date.now() / 1000)
		await env.DB.prepare("INSERT INTO metrics (system_id, ts, cpu, extra) VALUES (?, ?, ?, ?)")
			.bind(id, now - 10, 5, JSON.stringify({ uptime: 1000, gpu: 42 }))
			.run()

		const res = await worker.fetch(
			new Request(`http://test/api/v1/systems/${id}/metrics`, {
				headers: { Cookie: cookie },
			}),
			env
		)
		const body = (await res.json()) as { data: { extra: { uptime: number; gpu: number } | null }[] }
		expect(body.data[0]?.extra).toEqual({ uptime: 1000, gpu: 42 })
	})
})
