import { verifyAuth } from "@/lib/api"
import { api } from "@/lib/api"
import {
	$allSystemsById,
	$allSystemsByName,
	$downSystems,
	$longestSystemNameLen,
	$upSystems,
} from "@/lib/stores"
import { getVisualStringWidth, updateFavicon } from "@/lib/utils"
import type { SystemRecord } from "@/types"
/**
 * Systems manager untuk Pantaw.
 *
 * Menggantikan PocketBase realtime subscription dari Beszel dengan
 * polling interval 30 detik. Struktur store dan API publik dipertahankan
 * agar komponen Beszel tidak perlu banyak diubah.
 */
import type { PreinitializedMapStore } from "nanostores"
import { SystemStatus } from "./enums"

const MAX_SYSTEM_NAME_LENGTH = 22
const POLL_INTERVAL_MS = 30_000

let initialized = false
let pollTimer: ReturnType<typeof setInterval> | null = null

/** Initialize the systems manager and set up listeners */
export function init() {
	if (initialized) return
	initialized = true

	$allSystemsById.listen((newSystems, oldSystems, changedKey) => {
		const oldSystem = oldSystems[changedKey]
		const newSystem = newSystems[changedKey]

		if (oldSystem && !newSystem?.id) {
			removeFromStore(oldSystem, $upSystems)
			removeFromStore(oldSystem, $downSystems)
			removeFromStore(oldSystem, $allSystemsById)
		}

		if (!newSystem) {
			onSystemsChanged(newSystems, undefined)
			return
		}

		const newStatus = newSystem.status
		if (newStatus === SystemStatus.Up) {
			$upSystems.setKey(newSystem.id, newSystem)
			removeFromStore(newSystem, $downSystems)
		} else if (newStatus === SystemStatus.Down) {
			$downSystems.setKey(newSystem.id, newSystem)
			removeFromStore(newSystem, $upSystems)
		} else {
			removeFromStore(newSystem, $upSystems)
			removeFromStore(newSystem, $downSystems)
		}

		onSystemsChanged(newSystems, newSystem)
	})
}

function onSystemsChanged(_: Record<string, SystemRecord>, changedSystem: SystemRecord | undefined) {
	const downSystems = Object.values($downSystems.get())
	const nameLen = Math.min(MAX_SYSTEM_NAME_LENGTH, getVisualStringWidth(changedSystem?.name || ""))
	if (nameLen > $longestSystemNameLen.get()) {
		$longestSystemNameLen.set(nameLen)
	}
	updateFavicon(downSystems.length)
}

/** Fetch systems dari Pantaw API */
async function fetchSystems(): Promise<SystemRecord[]> {
	try {
		const res = await api.systems.$get()
		if (!res.ok) return []
		const data = (await res.json()) as SystemRecord[]
		return data
	} catch (error) {
		console.error("Failed to fetch systems:", error)
		return []
	}
}

export function add(system: SystemRecord) {
	try {
		$allSystemsByName.setKey(system.name, system)
		$allSystemsById.setKey(system.id, system)
	} catch (error) {
		console.error(error)
	}
}

export function update(system: SystemRecord) {
	try {
		const oldName = $allSystemsById.get()[system.id]?.name
		if (oldName !== system.name) {
			$allSystemsByName.setKey(oldName, undefined as unknown as SystemRecord)
		}
		add(system)
	} catch (error) {
		console.error(error)
	}
}

export function remove(system: SystemRecord) {
	removeFromStore(system, $allSystemsByName)
	removeFromStore(system, $allSystemsById)
	removeFromStore(system, $upSystems)
	removeFromStore(system, $downSystems)
}

function removeFromStore(system: SystemRecord, store: PreinitializedMapStore<Record<string, SystemRecord>>) {
	const key = store === $allSystemsByName ? system.name : system.id
	store.setKey(key, undefined as unknown as SystemRecord)
}

/** Refresh semua systems dari API */
export async function refresh() {
	try {
		const records = await fetchSystems()
		if (!records.length) {
			verifyAuth()
			return
		}
		for (const record of records) {
			add(record)
		}
	} catch (error) {
		console.error("Failed to refresh systems:", error)
	}
}

/**
 * Subscribe = mulai polling 30 detik.
 * Menggantikan PocketBase realtime subscription.
 */
export async function subscribe() {
	await refresh()
	if (pollTimer) clearInterval(pollTimer)
	pollTimer = setInterval(refresh, POLL_INTERVAL_MS)
}

/** Unsubscribe = stop polling */
export function unsubscribe() {
	if (pollTimer) {
		clearInterval(pollTimer)
		pollTimer = null
	}
}
