import type { Env } from "./index"

/**
 * Cron handlers untuk Pantaw.
 *
 * Schedule (lihat wrangler.toml [triggers] dan RFC 4.5):
 * - "*\/2 * * * *"  → alertAndStatusChecker
 * - "0 2 * * *"     → metricsCleanup
 *
 * Workers runtime memberi 30s wall time per cron invocation.
 */

export type AlertRow = {
	id: string
	system_id: string
	metric: "cpu" | "mem" | "disk" | "temp" | "status"
	threshold: number
	operator: "gt" | "lt" | "eq"
	duration_s: number
	enabled: number
	webhook_url: string | null
	last_fired: number | null
}

export type SystemRow = {
	id: string
	name: string
	timeout_seconds: number
	last_status: "up" | "down" | "unknown"
	last_status_at: number | null
	last_seen: number | null
}

const NUMERIC_METRICS = new Set(["cpu", "mem", "disk", "temp"])

function compareThreshold(value: number, op: AlertRow["operator"], threshold: number): boolean {
	switch (op) {
		case "gt":
			return value > threshold
		case "lt":
			return value < threshold
		case "eq":
			return value === threshold
	}
}

function statusToInt(status: SystemRow["last_status"]): number {
	if (status === "up") return 1
	if (status === "down") return 0
	return -1
}

function computeStatus(
	lastSeen: number | null,
	timeoutSeconds: number,
	nowSec: number
): SystemRow["last_status"] {
	if (lastSeen === null) return "unknown"
	return nowSec - lastSeen < timeoutSeconds ? "up" : "down"
}

async function sendWebhook(url: string, payload: unknown): Promise<void> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), 5000)
	try {
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		})
	} catch (err) {
		console.error("webhook_failed", url, err)
	} finally {
		clearTimeout(timeout)
	}
}

/**
 * Evaluasi satu alert. Return true jika sedang breaching.
 *
 * - Status alert: bandingkan int(status) dengan threshold pakai operator
 * - Numeric alert: query samples dalam window [now-duration_s, now],
 *   breaching jika SEMUA sample breach threshold (sustained breach)
 */
async function evaluateAlert(env: Env, alert: AlertRow, system: SystemRow, nowSec: number): Promise<boolean> {
	if (alert.metric === "status") {
		const statusInt = statusToInt(system.last_status)
		if (statusInt < 0) return false // unknown tidak fire
		return compareThreshold(statusInt, alert.operator, alert.threshold)
	}

	if (!NUMERIC_METRICS.has(alert.metric)) return false

	const windowStart = nowSec - Math.max(alert.duration_s, 1)
	const column = alert.metric // safe: enum-validated
	const { results } = await env.DB.prepare(
		`SELECT ${column} AS value FROM metrics
		 WHERE system_id = ? AND ts >= ? AND ${column} IS NOT NULL`
	)
		.bind(alert.system_id, windowStart)
		.all<{ value: number }>()

	if (results.length === 0) return false // no data dalam window
	return results.every((r) => compareThreshold(r.value, alert.operator, alert.threshold))
}

/**
 * Cron "*\/2 * * * *" — alert + status checker.
 *
 * 1. Untuk tiap system: hitung status dari MAX(metrics.ts), update
 *    `last_status` snapshot jika berubah. Status transition (up↔down)
 *    otomatis ter-cover oleh alert metric=status.
 * 2. Untuk tiap enabled alert: evaluasi threshold pakai window
 *    duration_s; jika transisi not_breaching → breaching, fire
 *    webhook (jika ada URL) dan set last_fired.
 * 3. Saat tidak lagi breaching, clear last_fired agar bisa re-fire
 *    di kejadian breach berikutnya.
 */
export async function alertAndStatusChecker(env: Env): Promise<void> {
	const nowSec = Math.floor(Date.now() / 1000)

	const { results: systems } = await env.DB.prepare(
		`SELECT s.id, s.name, s.timeout_seconds, s.last_status, s.last_status_at,
		        (SELECT MAX(ts) FROM metrics WHERE system_id = s.id) AS last_seen
		 FROM systems s`
	).all<SystemRow>()

	// Update last_status snapshot
	const systemMap = new Map<string, SystemRow>()
	for (const sys of systems) {
		const computed = computeStatus(sys.last_seen, sys.timeout_seconds, nowSec)
		if (computed !== sys.last_status) {
			await env.DB.prepare("UPDATE systems SET last_status = ?, last_status_at = ? WHERE id = ?")
				.bind(computed, nowSec, sys.id)
				.run()
			sys.last_status = computed
			sys.last_status_at = nowSec
		}
		systemMap.set(sys.id, sys)
	}

	const { results: alerts } = await env.DB.prepare("SELECT * FROM alerts WHERE enabled = 1").all<AlertRow>()

	for (const alert of alerts) {
		const system = systemMap.get(alert.system_id)
		if (!system) continue

		const breaching = await evaluateAlert(env, alert, system, nowSec)

		if (breaching && alert.last_fired === null) {
			// Transisi: fire webhook + set last_fired
			if (alert.webhook_url) {
				await sendWebhook(alert.webhook_url, {
					event: "alert.fired",
					alert_id: alert.id,
					system_id: alert.system_id,
					system_name: system.name,
					metric: alert.metric,
					operator: alert.operator,
					threshold: alert.threshold,
					duration_s: alert.duration_s,
					fired_at: nowSec,
				})
			}
			await env.DB.prepare("UPDATE alerts SET last_fired = ? WHERE id = ?").bind(nowSec, alert.id).run()
		} else if (!breaching && alert.last_fired !== null) {
			// Recovery: clear last_fired agar bisa re-fire saat breach lagi
			await env.DB.prepare("UPDATE alerts SET last_fired = NULL WHERE id = ?").bind(alert.id).run()
			if (alert.webhook_url) {
				await sendWebhook(alert.webhook_url, {
					event: "alert.resolved",
					alert_id: alert.id,
					system_id: alert.system_id,
					system_name: system.name,
					metric: alert.metric,
					resolved_at: nowSec,
				})
			}
		}
	}
}

/**
 * Cron `0 2 * * *` — hapus metrics yang lebih lama dari RETENTION_DAYS.
 */
export async function metricsCleanup(env: Env): Promise<void> {
	const retentionDays = Number.parseInt(env.RETENTION_DAYS, 10)
	if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
		console.warn("invalid_retention_days", env.RETENTION_DAYS)
		return
	}
	const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86_400
	const result = await env.DB.prepare("DELETE FROM metrics WHERE ts < ?").bind(cutoff).run()
	console.log("metrics_cleanup", { cutoff, deleted: result.meta.changes })
}

/**
 * Dispatcher: route berdasarkan controller.cron.
 */
export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
	switch (controller.cron) {
		case "*/2 * * * *":
			await alertAndStatusChecker(env)
			break
		case "0 2 * * *":
			await metricsCleanup(env)
			break
		default:
			console.warn("unknown_cron", controller.cron)
	}
}
