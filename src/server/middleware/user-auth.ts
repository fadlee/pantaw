import { getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import type { Env } from "../index"
import { defaultKidResolver, verifyJwt } from "../lib/jwt"

export const SESSION_COOKIE = "pantaw_session"

export type UserAuthVars = {
	userId: string
	userEmail: string
	userRole: "admin" | "user"
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
