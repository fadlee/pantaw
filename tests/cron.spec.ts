import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { alertAndStatusChecker, metricsCleanup } from "../src/server/cron"
import { sha256Hex } from "../src/server/lib/crypto"

const SYS_ID = "sys_cron_1"

async function reset() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM alerts"),
		env.DB.prepare("DELETE FROM metrics"),
		env.DB.prepare("DELETE FROM agent_tokens"),
		env.DB.prepare("DELETE FROM systems"),
	])
}

async function setupSystem(opts: { lastStatus?: "up" | "down" | "unknown"; timeoutSeconds?: number } = {}) {
	const tokenHash = await sha256Hex("dummy-token")
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		`INSERT INTO systems (id, name, host, agent_token_hash, timeout_seconds,
		 last_status, last_status_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			SYS_ID,
			"cron-test",
			"host",
			tokenHash,
			opts.timeoutSeconds ?? 90,
			opts.lastStatus ?? "unknown",
			null,
			now,
			now
		)
		.run()
}

async function insertMetric(ts: number, fields: Record<string, number | null>) {
	const cols = ["system_id", "ts", ...Object.keys(fields)]
	const placeholders = cols.map(() => "?").join(", ")
	const values = [SYS_ID, ts, ...Object.values(fields)]
	await env.DB.prepare(`INSERT OR IGNORE INTO metrics (${cols.join(", ")}) VALUES (${placeholders})`)
		.bind(...values)
		.run()
}

async function insertAlert(opts: {
	id?: string
	metric: "cpu" | "mem" | "disk" | "temp" | "status"
	operator: "gt" | "lt" | "eq"
	threshold: number
	duration_s?: number
	webhook_url?: string | null
}) {
	const id = opts.id ?? crypto.randomUUID()
	await env.DB.prepare(
		`INSERT INTO alerts (id, system_id, metric, threshold, operator, duration_s, enabled, webhook_url)
		 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
	)
		.bind(
			id,
			SYS_ID,
			opts.metric,
			opts.threshold,
			opts.operator,
			opts.duration_s ?? 60,
			opts.webhook_url ?? null
		)
		.run()
	return id
}

async function getAlert(id: string) {
	return env.DB.prepare("SELECT * FROM alerts WHERE id = ?")
		.bind(id)
		.first<{ last_fired: number | null; webhook_url: string | null }>()
}

async function getSystem(id = SYS_ID) {
	return env.DB.prepare("SELECT last_status, last_status_at FROM systems WHERE id = ?")
		.bind(id)
		.first<{ last_status: string; last_status_at: number | null }>()
}

describe("cron / alertAndStatusChecker", () => {
	beforeEach(async () => {
		await reset()
		vi.restoreAllMocks()
	})

	afterEach(async () => {
		await reset()
	})

	it("computes status=up when recent metric exists", async () => {
		await setupSystem({ lastStatus: "unknown" })
		await insertMetric(Math.floor(Date.now() / 1000) - 10, { cpu: 5, mem: 5 })

		await alertAndStatusChecker(env)

		const sys = await getSystem()
		expect(sys?.last_status).toBe("up")
		expect(sys?.last_status_at).toBeTypeOf("number")
	})

	it("computes status=down when no recent metric (timeout passed)", async () => {
		await setupSystem({ lastStatus: "up", timeoutSeconds: 60 })
		const old = Math.floor(Date.now() / 1000) - 600
		await insertMetric(old, { cpu: 5, mem: 5 })

		await alertAndStatusChecker(env)

		const sys = await getSystem()
		expect(sys?.last_status).toBe("down")
	})

	it("does not update last_status_at when status unchanged", async () => {
		await setupSystem({ lastStatus: "up" })
		await insertMetric(Math.floor(Date.now() / 1000) - 10, { cpu: 5, mem: 5 })

		await alertAndStatusChecker(env)
		const first = await getSystem()
		// last_status_at should remain null because status was already 'up'
		expect(first?.last_status).toBe("up")
		expect(first?.last_status_at).toBeNull()
	})

	it("fires CPU alert when threshold sustained over duration window", async () => {
		await setupSystem()
		const now = Math.floor(Date.now() / 1000)
		// 3 sample dengan cpu > 80 dalam 60s window
		await insertMetric(now - 50, { cpu: 90 })
		await insertMetric(now - 30, { cpu: 85 })
		await insertMetric(now - 10, { cpu: 95 })

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }))

		const alertId = await insertAlert({
			metric: "cpu",
			operator: "gt",
			threshold: 80,
			duration_s: 60,
			webhook_url: "https://example.com/webhook",
		})
		await alertAndStatusChecker(env)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const url = fetchMock.mock.calls[0]?.[0]
		expect(url).toBe("https://example.com/webhook")
		const init = fetchMock.mock.calls[0]?.[1]
		const payload = JSON.parse(init?.body as string)
		expect(payload.event).toBe("alert.fired")
		expect(payload.metric).toBe("cpu")

		const a = await getAlert(alertId)
		expect(a?.last_fired).toBeTypeOf("number")
	})

	it("does not fire if any sample in window is below threshold (sustained breach)", async () => {
		await setupSystem()
		const now = Math.floor(Date.now() / 1000)
		await insertMetric(now - 50, { cpu: 90 })
		await insertMetric(now - 30, { cpu: 50 }) // di bawah threshold
		await insertMetric(now - 10, { cpu: 95 })

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null))
		const alertId = await insertAlert({
			metric: "cpu",
			operator: "gt",
			threshold: 80,
			duration_s: 60,
		})
		await alertAndStatusChecker(env)

		expect(fetchMock).not.toHaveBeenCalled()
		const a = await getAlert(alertId)
		expect(a?.last_fired).toBeNull()
	})

	it("does not re-fire while still breaching (idempotent)", async () => {
		await setupSystem()
		const now = Math.floor(Date.now() / 1000)
		await insertMetric(now - 30, { cpu: 95 })

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null))
		const alertId = await insertAlert({
			metric: "cpu",
			operator: "gt",
			threshold: 80,
			duration_s: 60,
			webhook_url: "https://example.com/webhook",
		})

		await alertAndStatusChecker(env)
		await alertAndStatusChecker(env)
		await alertAndStatusChecker(env)

		expect(fetchMock).toHaveBeenCalledTimes(1) // hanya saat transition pertama
		const a = await getAlert(alertId)
		expect(a?.last_fired).toBeTypeOf("number")
	})

	it("sends resolved webhook + clears last_fired when value drops below threshold", async () => {
		await setupSystem()
		const now = Math.floor(Date.now() / 1000)
		await insertMetric(now - 30, { cpu: 95 })

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null))
		const alertId = await insertAlert({
			metric: "cpu",
			operator: "gt",
			threshold: 80,
			duration_s: 60,
			webhook_url: "https://example.com/webhook",
		})

		await alertAndStatusChecker(env) // fired
		expect(fetchMock).toHaveBeenCalledTimes(1)

		// Tambah sample baru di bawah threshold
		await insertMetric(now - 5, { cpu: 30 })
		await alertAndStatusChecker(env) // should resolve

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const second = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)
		expect(second.event).toBe("alert.resolved")

		const a = await getAlert(alertId)
		expect(a?.last_fired).toBeNull()
	})

	it("status alert: fires when system goes down (eq 0)", async () => {
		await setupSystem({ lastStatus: "up", timeoutSeconds: 60 })
		// metric lama -> akan compute jadi down
		await insertMetric(Math.floor(Date.now() / 1000) - 600, { cpu: 5 })

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null))
		const alertId = await insertAlert({
			metric: "status",
			operator: "eq",
			threshold: 0, // 0 = down
			webhook_url: "https://example.com/down",
		})

		await alertAndStatusChecker(env)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const a = await getAlert(alertId)
		expect(a?.last_fired).toBeTypeOf("number")
	})

	it("does not fire disabled alert", async () => {
		await setupSystem()
		await insertMetric(Math.floor(Date.now() / 1000) - 30, { cpu: 95 })

		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null))
		const id = crypto.randomUUID()
		await env.DB.prepare(
			`INSERT INTO alerts (id, system_id, metric, threshold, operator, duration_s, enabled, webhook_url)
			 VALUES (?, ?, 'cpu', 80, 'gt', 60, 0, 'https://example.com/x')`
		)
			.bind(id, SYS_ID)
			.run()

		await alertAndStatusChecker(env)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("alert without metrics in window does not fire", async () => {
		await setupSystem()
		// Tidak ada metric di-insert
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null))
		const alertId = await insertAlert({
			metric: "cpu",
			operator: "gt",
			threshold: 80,
			webhook_url: "https://example.com/x",
		})
		await alertAndStatusChecker(env)
		expect(fetchMock).not.toHaveBeenCalled()
		const a = await getAlert(alertId)
		expect(a?.last_fired).toBeNull()
	})
})

describe("cron / metricsCleanup", () => {
	beforeEach(async () => {
		await reset()
	})

	afterEach(async () => {
		await reset()
	})

	it("deletes metrics older than RETENTION_DAYS", async () => {
		await setupSystem()
		const now = Math.floor(Date.now() / 1000)
		const retentionDays = Number.parseInt(env.RETENTION_DAYS, 10)
		const oldTs = now - (retentionDays + 1) * 86_400
		const recentTs = now - 60

		await insertMetric(oldTs, { cpu: 1 })
		await insertMetric(recentTs, { cpu: 2 })

		await metricsCleanup(env)

		const { results } = await env.DB.prepare("SELECT ts FROM metrics ORDER BY ts").all<{ ts: number }>()
		expect(results.map((r) => r.ts)).toEqual([recentTs])
	})

	it("no-op when RETENTION_DAYS invalid", async () => {
		await setupSystem()
		const now = Math.floor(Date.now() / 1000)
		await insertMetric(now - 86_400 * 365, { cpu: 1 })

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		await metricsCleanup({ ...env, RETENTION_DAYS: "not-a-number" } as unknown as typeof env)

		expect(warn).toHaveBeenCalled()
		const row = await env.DB.prepare("SELECT COUNT(*) as n FROM metrics").first<{ n: number }>()
		expect(row?.n).toBe(1)
	})
})
