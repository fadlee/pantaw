import type { AlertMap, ChartTimes, SystemRecord, UpdateInfo, UserSettings } from "@/types"
import { type ReadableAtom, atom, computed, listenKeys, map } from "nanostores"
import { Unit } from "./enums"

/** Default layout width. Used as fallback when user setting is unset. */
export const defaultLayoutWidth = 1580

/** Store if user is authenticated — diupdate oleh api.ts setCurrentUser() */
export const $authenticated = atom(false)

/** Map of system records by name */
export const $allSystemsByName = map<Record<string, SystemRecord>>({})
/** Map of system records by id */
export const $allSystemsById = map<Record<string, SystemRecord>>({})
/** Map of up systems by id */
export const $upSystems = map<Record<string, SystemRecord>>({})
/** Map of down systems by id */
export const $downSystems = map<Record<string, SystemRecord>>({})
/** Map of paused systems by id — stub untuk kompatibilitas Beszel (Pantaw tidak punya paused) */
export const $pausedSystems = map<Record<string, SystemRecord>>({})
/** List of all system records */
export const $systems: ReadableAtom<SystemRecord[]> = computed($allSystemsById, Object.values)

/** Map of alert records by system id and alert name */
export const $alerts = map<AlertMap>({})

/** SSH public key — stub, tidak dipakai di Pantaw */
export const $publicKey = atom("")

/** New version info if an update is available, otherwise undefined */
export const $newVersion = atom<UpdateInfo | undefined>()

/** Chart time period */
export const $chartTime = atom<ChartTimes>("1h")

/** Whether to display average or max chart values */
export const $maxValues = atom(false)

/** User settings */
export const $userSettings = map<UserSettings>({
	chartTime: "1h",
	emails: [],
	unitNet: Unit.Bytes,
	unitTemp: Unit.Celsius,
})

// update chart time on change
listenKeys($userSettings, ["chartTime"], ({ chartTime }) => $chartTime.set(chartTime))

/** Container chart filter */
export const $containerFilter = atom("")

/** Temperature chart filter */
export const $temperatureFilter = atom("")

/** Fallback copy to clipboard dialog content */
export const $copyContent = atom("")

/** Direction for localization */
export const $direction = atom<"ltr" | "rtl">("ltr")

/** Longest system name length */
export const $longestSystemNameLen = atom(8)
