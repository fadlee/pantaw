import { apiClient, getFromTimestamp } from "@/lib/api"
import { chartTimeData } from "@/lib/utils"
import type { ChartData, ChartTimes, ContainerStatsRecord, SystemStatsRecord } from "@/types"
import { timeTicks } from "d3-time"

type ChartTimeData = {
	time: number
	data: {
		ticks: number[]
		domain: number[]
	}
	chartTime: ChartTimes
}

export const cache = new Map<
	string,
	ChartTimeData | SystemStatsRecord[] | ContainerStatsRecord[] | ChartData["containerData"]
>()

// create ticks and domain for charts
export function getTimeData(chartTime: ChartTimes, lastCreated: number) {
	const cached = cache.get("td") as ChartTimeData | undefined
	if (cached && cached.chartTime === chartTime) {
		if (!lastCreated || cached.time >= lastCreated) {
			return cached.data
		}
	}

	// const buffer = chartTime === "1m" ? 400 : 20_000
	const now = new Date(Date.now())
	const startTime = chartTimeData[chartTime].getOffset(now)
	const ticks = timeTicks(startTime, now, chartTimeData[chartTime].ticks ?? 12).map((date) => date.getTime())
	const data = {
		ticks,
		domain: [chartTimeData[chartTime].getOffset(now).getTime(), now.getTime()],
	}
	cache.set("td", { time: now.getTime(), data, chartTime })
	return data
}

/** Append new records onto prev with gap detection. Converts string `created` values to ms timestamps in place.
 * Pass `maxLen` to cap the result length in one copy instead of slicing again after the call. */
export function appendData<T extends { created: string | number | null }>(
	prev: T[],
	newRecords: T[],
	expectedInterval: number,
	maxLen?: number
): T[] {
	if (!newRecords.length) return prev
	// Pre-trim prev so the single slice() below is the only copy we make
	const trimmed = maxLen && prev.length >= maxLen ? prev.slice(-(maxLen - newRecords.length)) : prev
	const result = trimmed.slice()
	let prevTime = (trimmed.at(-1)?.created as number) ?? 0
	for (const record of newRecords) {
		if (record.created !== null) {
			if (typeof record.created === "string") {
				record.created = new Date(record.created).getTime()
			}
			if (prevTime && (record.created as number) - prevTime > expectedInterval * 1.5) {
				result.push({ created: null, ...("stats" in record ? { stats: null } : {}) } as T)
			}
			prevTime = record.created as number
		}
		result.push(record)
	}
	return result
}

/**
 * Fetch metrics dari Pantaw API dan convert ke format SystemStatsRecord
 * yang diharapkan oleh Beszel chart components.
 *
 * Pantaw menyimpan metrik flat (cpu, mem, disk, dll) sedangkan Beszel
 * menggunakan nested `stats` object. Kita wrap flat fields ke dalam
 * `stats` supaya chart hooks tidak perlu diubah.
 */
export async function getStats<T extends SystemStatsRecord | ContainerStatsRecord>(
	collection: string,
	systemId: string,
	chartTime: ChartTimes
): Promise<T[]> {
	// Container stats tidak tersedia di Pantaw MVP
	if (collection !== "system_stats") {
		return []
	}

	const cachedStats = cache.get(`${systemId}_${chartTime}_${collection}`) as T[] | undefined
	const lastCached = cachedStats?.at(-1)?.created as number | undefined

	const fromTs = getFromTimestamp(chartTime, lastCached ? new Date(lastCached + 1000) : undefined)
	const nowTs = Math.floor(Date.now() / 1000)

	// Pilih bucket size berdasarkan chart time range
	const bucketMap: Record<ChartTimes, number | undefined> = {
		"1m": undefined, // raw
		"1h": undefined, // raw
		"12h": 120, // 2 menit
		"24h": 300, // 5 menit
		"1w": 1800, // 30 menit
		"30d": 7200, // 2 jam
	}
	const bucket = bucketMap[chartTime]

	try {
		const res = await apiClient.api.v1.systems[":id"].metrics.$get({
			param: { id: systemId },
			query: {
				from: String(fromTs),
				to: String(nowTs),
				...(bucket ? { bucket: String(bucket) } : {}),
				limit: "1000",
			},
		})
		if (!res.ok) return cachedStats ?? []

		const json = (await res.json()) as {
			data: {
				ts: number
				cpu?: number
				mem?: number
				mem_used?: number
				mem_total?: number
				disk?: number
				disk_read?: number
				disk_write?: number
				net_rx?: number
				net_tx?: number
				load1?: number
				load5?: number
				load15?: number
				temp?: number
			}[]
		}

		// Convert flat Pantaw metrics ke nested Beszel SystemStatsRecord format
		const records = json.data.map((m) => ({
			created: m.ts * 1000, // Pantaw: unix sec, Beszel: ms
			stats: {
				cpu: m.cpu ?? 0,
				mp: m.mem ?? 0,
				mu: m.mem_used != null ? m.mem_used / 1024 / 1024 / 1024 : 0, // bytes -> GB
				m: m.mem_total != null ? m.mem_total / 1024 / 1024 / 1024 : 0,
				dp: m.disk ?? 0,
				dr: m.disk_read != null ? m.disk_read / 1024 / 1024 : 0, // bytes/s -> MB/s
				dw: m.disk_write != null ? m.disk_write / 1024 / 1024 : 0,
				ns: m.net_tx != null ? m.net_tx / 1024 / 1024 : 0, // bytes/s -> MB/s
				nr: m.net_rx != null ? m.net_rx / 1024 / 1024 : 0,
				la: m.load1 != null ? [m.load1, m.load5 ?? 0, m.load15 ?? 0] as [number, number, number] : undefined,
				dt: m.temp,
			},
			system: systemId,
		} as unknown as T))

		// Merge dengan cache (append baru, hindari duplikat)
		const merged = cachedStats ? appendData(cachedStats, records, chartTimeData[chartTime].expectedInterval) : records
		cache.set(`${systemId}_${chartTime}_${collection}`, merged as SystemStatsRecord[])
		return merged as T[]
	} catch (e) {
		console.error("getStats", e)
		return cachedStats ?? []
	}
}

export function makeContainerData(containers: ContainerStatsRecord[]): ChartData["containerData"] {
	const result = [] as ChartData["containerData"]
	for (const { created, stats } of containers) {
		if (!created) {
			result.push({ created: null } as ChartData["containerData"][0])
			continue
		}
		result.push(makeContainerPoint(new Date(created).getTime(), stats))
	}
	return result
}

/** Transform a single realtime container stats message into a ChartDataContainer point. */
export function makeContainerPoint(
	created: number,
	stats: ContainerStatsRecord["stats"]
): ChartData["containerData"][0] {
	const point: ChartData["containerData"][0] = { created } as ChartData["containerData"][0]
	for (const container of stats) {
		;(point as Record<string, unknown>)[container.n] = container
	}
	return point
}

export function dockerOrPodman(str: string, isPodman: boolean): string {
	if (isPodman) {
		return str.replace("docker", "podman").replace("Docker", "Podman")
	}
	return str
}
