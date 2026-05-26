import {
	BatteryMediumIcon,
	EthernetIcon,
	GpuIcon,
	HourglassIcon,
	ThermometerIcon,
} from "@/components/ui/icons"
import { $alerts } from "@/lib/stores"
import type { AlertInfo, AlertRecord } from "@/types"
import { t } from "@lingui/core/macro"
import { CpuIcon, HardDriveIcon, MemoryStickIcon, ServerIcon } from "lucide-react"
import { api, apiClient } from "./api"

const POLL_INTERVAL_MS = 30_000

/** Alert info for each alert type */
export const alertInfo: Record<string, AlertInfo> = {
	Status: {
		name: () => t`Status`,
		unit: "",
		icon: ServerIcon,
		desc: () => t`Triggers when status switches between up and down`,
		singleDesc: () => `${t`System`} ${t`Down`}`,
	},
	CPU: {
		name: () => t`CPU Usage`,
		unit: "%",
		icon: CpuIcon,
		desc: () => t`Triggers when CPU usage exceeds a threshold`,
	},
	Memory: {
		name: () => t`Memory Usage`,
		unit: "%",
		icon: MemoryStickIcon,
		desc: () => t`Triggers when memory usage exceeds a threshold`,
	},
	Disk: {
		name: () => t`Disk Usage`,
		unit: "%",
		icon: HardDriveIcon,
		desc: () => t`Triggers when usage of any disk exceeds a threshold`,
	},
	Bandwidth: {
		name: () => t`Bandwidth`,
		unit: " MB/s",
		icon: EthernetIcon,
		desc: () => t`Triggers when combined up/down exceeds a threshold`,
		max: 250,
	},
	GPU: {
		name: () => t`GPU Usage`,
		unit: "%",
		icon: GpuIcon,
		desc: () => t`Triggers when GPU usage exceeds a threshold`,
	},
	Temperature: {
		name: () => t`Temperature`,
		unit: "°C",
		icon: ThermometerIcon,
		desc: () => t`Triggers when any sensor exceeds a threshold`,
	},
	LoadAvg1: {
		name: () => t`Load Average 1m`,
		unit: "",
		icon: HourglassIcon,
		max: 100,
		min: 0.1,
		start: 10,
		step: 0.1,
		desc: () => t`Triggers when 1 minute load average exceeds a threshold`,
	},
	LoadAvg5: {
		name: () => t`Load Average 5m`,
		unit: "",
		icon: HourglassIcon,
		max: 100,
		min: 0.1,
		start: 10,
		step: 0.1,
		desc: () => t`Triggers when 5 minute load average exceeds a threshold`,
	},
	LoadAvg15: {
		name: () => t`Load Average 15m`,
		unit: "",
		icon: HourglassIcon,
		min: 0.1,
		max: 100,
		start: 10,
		step: 0.1,
		desc: () => t`Triggers when 15 minute load average exceeds a threshold`,
	},
	Battery: {
		name: () => t`Battery`,
		unit: "%",
		icon: BatteryMediumIcon,
		desc: () => t`Triggers when battery charge drops below a threshold`,
		start: 20,
		invert: true,
	},
} as const

type PantawAlert = {
	id: string
	system_id: string
	metric: string
	threshold: number
	operator: string
	duration_s: number
	enabled: boolean
	webhook_url: string | null
	last_fired: number | null
}

/** Convert Pantaw alert to Beszel AlertRecord shape */
function toAlertRecord(a: PantawAlert): AlertRecord {
	return {
		id: a.id,
		system: a.system_id,
		name: a.metric,
		triggered: a.last_fired !== null,
		value: a.threshold,
		min: 0,
	}
}

export const alertManager = (() => {
	let pollTimer: ReturnType<typeof setInterval> | null = null

	function add(alerts: AlertRecord[]) {
		for (const alert of alerts) {
			const systemId = alert.system
			const systemAlerts = $alerts.get()[systemId] ?? new Map()
			const newAlerts = new Map(systemAlerts)
			newAlerts.set(alert.name, alert)
			$alerts.setKey(systemId, newAlerts)
		}
	}

	function remove(alerts: Pick<AlertRecord, "name" | "system">[]) {
		for (const alert of alerts) {
			const systemId = alert.system
			const systemAlerts = $alerts.get()[systemId]
			const newAlerts = new Map(systemAlerts)
			newAlerts.delete(alert.name)
			$alerts.setKey(systemId, newAlerts)
		}
	}

	async function fetchAlerts(): Promise<AlertRecord[]> {
		try {
			const res = await fetch("/api/v1/alerts")
			if (!res.ok) return []
			const data = (await res.json()) as PantawAlert[]
			return data.map(toAlertRecord)
		} catch {
			return []
		}
	}

	async function refresh() {
		const records = await fetchAlerts()
		add(records)
	}

	async function subscribe() {
		await refresh()
		if (pollTimer) clearInterval(pollTimer)
		pollTimer = setInterval(refresh, POLL_INTERVAL_MS)
	}

	function unsubscribe() {
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = null
		}
	}

	return { add, remove, subscribe, unsubscribe, refresh }
})()
