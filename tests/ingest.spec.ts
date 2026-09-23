import { env } from "cloudflare:test"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import worker from "../src/server/index"
import { sha256Hex } from "../src/server/lib/crypto"

const SYSTEM_ID = "sys_test_1"

let currentToken = ""

async function registerToken(token: string) {
	const tokenHash = await sha256Hex(token)
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		"INSERT OR IGNORE INTO agent_tokens (id, system_id, token_hash, created_at) VALUES (?, ?, ?, ?)"
	)
		.bind(`tok_${tokenHash.slice(0, 8)}`, SYSTEM_ID, tokenHash, now)
		.run()
}

async function setupSystem() {
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		`INSERT OR IGNORE INTO systems (id, name, host, agent_token_hash, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(SYSTEM_ID, "test", "localhost", "placeholder", now, now)
		.run()
}

async function reset() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM metrics"),
		env.DB.prepare("DELETE FROM agent_tokens"),
		env.DB.prepare("DELETE FROM systems"),
	])
}

function ingestRequest(body: unknown, token = currentToken) {
	return new Request("http://test/api/v1/ingest", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	})
}

function validPayload(overrides: Record<string, unknown> = {}) {
	return {
		ts: Math.floor(Date.now() / 1000),
		cpu: 23.4,
		mem: 61.2,
		mem_used: 4_194_304_000,
		mem_total: 8_388_608_000,
		disk: 45,
		net_rx: 1024,
		net_tx: 512,
		load: [1.2, 0.9, 0.7],
		temp: 52.3,
		uptime: 100,
		...overrides,
	}
}

describe("/api/v1/ingest", () => {
	beforeEach(async () => {
		await reset()
		await setupSystem()
		// Token unik per test agar bucket rate-limit per-token tidak saling
		// mengganggu antar test (limit di prod: 3/menit per token).
		currentToken = `test-token-${crypto.randomUUID()}`
		await registerToken(currentToken)
	})

	afterAll(async () => {
		await reset()
	})

	it("rejects request without Authorization header", async () => {
		const req = new Request("http://test/api/v1/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validPayload()),
		})
		const res = await worker.fetch(req, env)
		expect(res.status).toBe(401)
	})

	it("rejects invalid token", async () => {
		const res = await worker.fetch(ingestRequest(validPayload(), "wrong-token"), env)
		expect(res.status).toBe(401)
	})

	it("accepts valid single payload and writes 1 row", async () => {
		const res = await worker.fetch(ingestRequest(validPayload()), env)
		expect(res.status).toBe(204)

		const { results } = await env.DB.prepare("SELECT system_id, cpu, mem FROM metrics WHERE system_id = ?")
			.bind(SYSTEM_ID)
			.all<{ system_id: string; cpu: number; mem: number }>()
		expect(results).toHaveLength(1)
		expect(results[0]?.cpu).toBe(23.4)
	})

	it("accepts array payload (batch)", async () => {
		const baseTs = Math.floor(Date.now() / 1000)
		const batch = [
			validPayload({ ts: baseTs - 60, cpu: 10 }),
			validPayload({ ts: baseTs - 30, cpu: 20 }),
			validPayload({ ts: baseTs, cpu: 30 }),
		]
		const res = await worker.fetch(ingestRequest(batch), env)
		expect(res.status).toBe(204)

		const { results } = await env.DB.prepare("SELECT cpu FROM metrics WHERE system_id = ? ORDER BY ts")
			.bind(SYSTEM_ID)
			.all<{ cpu: number }>()
		expect(results.map((r) => r.cpu)).toEqual([10, 20, 30])
	})

	it("is idempotent on retry (INSERT OR IGNORE)", async () => {
		const payload = validPayload()
		const first = await worker.fetch(ingestRequest(payload), env)
		expect(first.status).toBe(204)
		const second = await worker.fetch(ingestRequest(payload), env)
		expect(second.status).toBe(204)

		const row = await env.DB.prepare("SELECT COUNT(*) as n FROM metrics WHERE system_id = ?")
			.bind(SYSTEM_ID)
			.first<{ n: number }>()
		expect(row?.n).toBe(1)
	})

	it("rejects payload with ts too far in the past (clock skew)", async () => {
		const oldTs = Math.floor(Date.now() / 1000) - 10 * 60
		const res = await worker.fetch(ingestRequest(validPayload({ ts: oldTs })), env)
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe("clock_skew")
	})

	it("rejects payload with ts too far in the future", async () => {
		const futureTs = Math.floor(Date.now() / 1000) + 5 * 60
		const res = await worker.fetch(ingestRequest(validPayload({ ts: futureTs })), env)
		expect(res.status).toBe(400)
	})

	it("rejects malformed payload (missing ts)", async () => {
		const { ts, ...rest } = validPayload()
		void ts
		const res = await worker.fetch(ingestRequest(rest), env)
		expect(res.status).toBe(400)
	})

	it("rejects empty array", async () => {
		const res = await worker.fetch(ingestRequest([]), env)
		expect(res.status).toBe(400)
	})

	it("stores unknown fields into extra column as JSON", async () => {
		const payload = {
			...validPayload(),
			containers: [{ name: "nginx", cpu: 0.8, mem: 100 }],
			gpu: 42,
		}
		const res = await worker.fetch(ingestRequest(payload), env)
		expect(res.status).toBe(204)

		const row = await env.DB.prepare("SELECT extra FROM metrics WHERE system_id = ?")
			.bind(SYSTEM_ID)
			.first<{ extra: string | null }>()
		expect(row?.extra).toBeTruthy()
		const parsed = JSON.parse(row?.extra ?? "{}")
		expect(parsed.uptime).toBe(100)
		expect(parsed.containers).toHaveLength(1)
	})

	it("populates CACHE_KV with latest payload", async () => {
		const payload = validPayload({ cpu: 77.7 })
		await worker.fetch(ingestRequest(payload), env)

		const cached = await env.CACHE_KV.get(`metrics:${SYSTEM_ID}:latest`)
		expect(cached).toBeTruthy()
		const parsed = JSON.parse(cached ?? "{}")
		expect(parsed.cpu).toBe(77.7)
	})

	it("automatically updates system host from cf-connecting-ip when empty", async () => {
		await env.DB.prepare("UPDATE systems SET host = '' WHERE id = ?").bind(SYSTEM_ID).run()

		const req = new Request("http://test/api/v1/ingest", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${currentToken}`,
				"CF-Connecting-IP": "203.0.113.195",
			},
			body: JSON.stringify(validPayload()),
		})
		const res = await worker.fetch(req, env)
		expect(res.status).toBe(204)

		const row = await env.DB.prepare("SELECT host FROM systems WHERE id = ?").bind(SYSTEM_ID).first<{ host: string }>()
		expect(row?.host).toBe("203.0.113.195")
	})

	it("does not overwrite system host if host is already set", async () => {
		await env.DB.prepare("UPDATE systems SET host = '10.0.0.5' WHERE id = ?").bind(SYSTEM_ID).run()

		const req = new Request("http://test/api/v1/ingest", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${currentToken}`,
				"CF-Connecting-IP": "203.0.113.195",
			},
			body: JSON.stringify(validPayload()),
		})
		const res = await worker.fetch(req, env)
		expect(res.status).toBe(204)

		const row = await env.DB.prepare("SELECT host FROM systems WHERE id = ?").bind(SYSTEM_ID).first<{ host: string }>()
		expect(row?.host).toBe("10.0.0.5")
	})

	it("extracts IP from x-real-ip or x-forwarded-for fallback", async () => {
		await env.DB.prepare("UPDATE systems SET host = '' WHERE id = ?").bind(SYSTEM_ID).run()

		const req = new Request("http://test/api/v1/ingest", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${currentToken}`,
				"X-Forwarded-For": "198.51.100.22, 10.0.0.1",
			},
			body: JSON.stringify(validPayload()),
		})
		const res = await worker.fetch(req, env)
		expect(res.status).toBe(204)

		const row = await env.DB.prepare("SELECT host FROM systems WHERE id = ?").bind(SYSTEM_ID).first<{ host: string }>()
		expect(row?.host).toBe("198.51.100.22")
	})

	it("returns 429 when exceeding rate limit (per-token bucket)", async () => {
		// Limit prod = 3/menit per token. Kirim 4 request berturut-turut
		// dengan ts berbeda agar tidak kena idempotensi.
		const baseTs = Math.floor(Date.now() / 1000)
		const statuses: number[] = []
		for (let i = 0; i < 5; i++) {
			const res = await worker.fetch(ingestRequest(validPayload({ ts: baseTs - i })), env)
			statuses.push(res.status)
		}
		// Yang sukses 3, sisanya 429
		const ok = statuses.filter((s) => s === 204).length
		const limited = statuses.filter((s) => s === 429).length
		expect(ok).toBe(3)
		expect(limited).toBe(2)
	})
})
