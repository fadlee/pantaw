import { getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import type { Env } from "../index"
import { defaultKidResolver, verifyJwt } from "../lib/jwt"

export const SESSION_COOKIE = "pantaw_session"

export type UserAuthVars = {
	userId: string
	userEmail: string
	userRole: "admin" | "user"
	userSystemIds: string[]
	jti: string
}

/**
 * Verifikasi JWT dari cookie HttpOnly. Jika valid, set context vars
 * untuk dipakai downstream handler. Jika tidak, return 401.
 *
 * Lihat RFC 8.3 dan 4.7. Cookie disimpan oleh server saat login,
 * SameSite=Strict mencegah CSRF.
 */
export const userAuth = createMiddleware<{ Bindings: Env; Variables: UserAuthVars }>(async (c, next) => {
	const token = getCookie(c, SESSION_COOKIE)
	if (!token) {
		return c.json({ error: "unauthenticated" }, 401)
	}

	const result = await verifyJwt(token, {
		resolveSecret: defaultKidResolver(c.env as unknown as Record<string, unknown>),
	})
	if (!result.ok) {
		return c.json({ error: "unauthenticated", reason: result.error }, 401)
	}

	c.set("userId", result.payload.sub)
	c.set("userEmail", result.payload.email)
	c.set("userRole", result.payload.role)
	c.set("userSystemIds", result.payload.system_ids ?? [])
	// ponytail: system_ids embedded in JWT can become stale if permissions change before session expiry (24h). Upgrade to DB lookup or token versioning when full user management is implemented.
	c.set("jti", result.payload.jti)
	await next()
})

/**
 * Middleware tambahan: pastikan user adalah admin. Pakai setelah userAuth.
 */
export const requireAdmin = createMiddleware<{ Bindings: Env; Variables: UserAuthVars }>(async (c, next) => {
	if (c.get("userRole") !== "admin") {
		return c.json({ error: "forbidden" }, 403)
	}
	await next()
})

export function scopeSystems(c: { get: <K extends keyof UserAuthVars>(k: K) => UserAuthVars[K] }): {
	isAdmin: boolean
	allowedIds: string[]
} {
	const isAdmin = c.get("userRole") === "admin"
	const allowedIds = c.get("userSystemIds") || []
	return { isAdmin, allowedIds }
}
