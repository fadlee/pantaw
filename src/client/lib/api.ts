import { toast } from "@/components/ui/use-toast"
import type { AppType } from "@/server/index"
import type { ChartTimes, UserSettings } from "@/types"
/**
 * Pantaw API client — menggantikan PocketBase SDK dari Beszel.
 *
 * Menggunakan Hono RPC client untuk type-safe API calls ke Worker.
 * Auth via cookie HttpOnly (di-set server saat login/setup).
 */
import { t } from "@lingui/core/macro"
import { hc } from "hono/client"
import { $alerts, $allSystemsById, $allSystemsByName, $authenticated, $userSettings } from "./stores"
import { chartTimeData } from "./utils"

/** Hono RPC client — base URL "/" karena same-origin deployment */
export const apiClient = hc<AppType>("/")

/** Shorthand untuk akses API routes */
export const api = apiClient.api.v1

// ─── Auth state ───────────────────────────────────────────────────────────────

export type AuthUser = {
	id: string
	email: string
	role: "admin" | "user"
}

let _currentUser: AuthUser | null = null

export const isAdmin = () => _currentUser?.role === "admin"
export const isReadOnlyUser = () => _currentUser?.role === "user"
export const getCurrentUser = () => _currentUser
export const setCurrentUser = (user: AuthUser | null) => {
	_currentUser = user
	$authenticated.set(user !== null)
}

/** Verifikasi sesi aktif via /me. Dipanggil saat app mount. */
export const verifyAuth = async () => {
	try {
		const res = await api.auth.me.$get()
		if (res.ok) {
			const user = (await res.json()) as AuthUser
			setCurrentUser(user)
			return true
		}
	} catch {
		// network error
	}
	logOut()
	toast({
		title: t`Failed to authenticate`,
		description: t`Please log in again`,
		variant: "destructive",
	})
	return false
}

/** Logout: panggil endpoint, clear state lokal */
export function logOut() {
	$allSystemsByName.set({})
	$allSystemsById.set({})
	$alerts.set({})
	$userSettings.set({} as UserSettings)
	setCurrentUser(null)
	sessionStorage.setItem("lo", "t")
	// Panggil logout endpoint (fire-and-forget, clear cookie di server)
	api.auth.logout.$post().catch(() => {})
}

// ─── User settings ────────────────────────────────────────────────────────────

/** User settings disimpan di localStorage (tidak ada tabel user_settings di Pantaw) */
const SETTINGS_KEY = "pantaw_user_settings"

export async function updateUserSettings() {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY)
		if (raw) {
			const settings = JSON.parse(raw) as UserSettings
			$userSettings.set(settings)
		}
	} catch (e) {
		console.error("get settings", e)
	}
}

export function saveUserSettings(settings: UserSettings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
		$userSettings.set(settings)
	} catch (e) {
		console.error("save settings", e)
	}
}

// ─── Timestamp helper ─────────────────────────────────────────────────────────

/**
 * Konversi ChartTimes ke unix timestamp (detik) untuk query metrics.
 * Menggantikan getPbTimestamp() yang return format PocketBase.
 */
export function getFromTimestamp(timeString: ChartTimes, d?: Date): number {
	d ||= chartTimeData[timeString].getOffset(new Date())
	return Math.floor(d.getTime() / 1000)
}

/**
 * Backward-compat alias untuk kode Beszel yang masih pakai getPbTimestamp.
 * Return unix timestamp (number) bukan string PocketBase.
 */
export function getPbTimestamp(timeString: ChartTimes, d?: Date): number {
	return getFromTimestamp(timeString, d)
}
