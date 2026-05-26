import { vValidator } from "@hono/valibot-validator"
import { Hono } from "hono"
import { deleteCookie, setCookie } from "hono/cookie"
import { LoginBodySchema } from "../../shared/schemas"
import type { Env } from "../index"
import { defaultKidResolver, signJwt } from "../lib/jwt"
import { hashPassword, verifyPassword } from "../lib/password"
import type { UserAuthVars } from "../middleware/user-auth"
import { SESSION_COOKIE, userAuth } from "../middleware/user-auth"

const app = new Hono<{ Bindings: Env; Variables: UserAuthVars }>()

const SESSION_TTL_SEC = 24 * 60 * 60 // 24 jam
const LOGIN_THROTTLE_LIMIT = 5
const LOGIN_THROTTLE_WINDOW_SEC = 15 * 60 // 15 menit

type ThrottleState = {
	count: number
	first_attempt_at: number
}

/**
 * Login throttle per email (bukan IP) sesuai RFC 8.3.
 * Disimpan di RATE_KV dengan key `login:{email}`.
 */
async function checkLoginThrottle(
	env: Env,
	email: string
): Promise<{ allowed: boolean; retryAfter: number }> {
	const key = `login:${email}`
	const now = Math.floor(Date.now() / 1000)
	const raw = await env.RATE_KV.get(key)
	if (!raw) return { allowed: true, retryAfter: 0 }

	let state: ThrottleState
	try {
		state = JSON.parse(raw) as ThrottleState
	} catch {
		// Corrupt entry: reset
		await env.RATE_KV.delete(key)
		return { allowed: true, retryAfter: 0 }
	}

	const windowEnd = state.first_attempt_at + LOGIN_THROTTLE_WINDOW_SEC
	if (now >= windowEnd) {
		// Window habis, slate clean
		await env.RATE_KV.delete(key)
		return { allowed: true, retryAfter: 0 }
	}
	if (state.count >= LOGIN_THROTTLE_LIMIT) {
		return { allowed: false, retryAfter: windowEnd - now }
	}
	return { allowed: true, retryAfter: 0 }
}

async function recordLoginFailure(env: Env, email: string) {
	const key = `login:${email}`
	const now = Math.floor(Date.now() / 1000)
	const raw = await env.RATE_KV.get(key)
	let state: ThrottleState
	if (raw) {
		try {
			state = JSON.parse(raw) as ThrottleState
			state.count += 1
		} catch {
			state = { count: 1, first_attempt_at: now }
		}
	} else {
		state = { count: 1, first_attempt_at: now }
	}
	const windowRemain = state.first_attempt_at + LOGIN_THROTTLE_WINDOW_SEC - now
	await env.RATE_KV.put(key, JSON.stringify(state), {
		expirationTtl: Math.max(60, windowRemain),
	})
}

async function clearLoginThrottle(env: Env, email: string) {
	await env.RATE_KV.delete(`login:${email}`)
}

type UserRow = {
	id: string
	email: string
	password_hash: string
	role: "admin" | "user"
}

app.post("/login", vValidator("json", LoginBodySchema), async (c) => {
	const { email, password } = c.req.valid("json")
	const normalizedEmail = email.trim().toLowerCase()

	const throttle = await checkLoginThrottle(c.env, normalizedEmail)
	if (!throttle.allowed) {
		return c.json({ error: "too_many_attempts", retry_after: throttle.retryAfter }, 429, {
			"Retry-After": String(throttle.retryAfter),
		})
	}

	const user = await c.env.DB.prepare(
		"SELECT id, email, password_hash, role FROM users WHERE email = ? LIMIT 1"
	)
		.bind(normalizedEmail)
		.first<UserRow>()

	// Pakai dummy hash untuk timing equalization saat user tidak ada
	const dummyHash =
		"$pbkdf2-sha256$i=600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	const verifyResult = await verifyPassword(password, user?.password_hash ?? dummyHash)

	if (!user || !verifyResult.valid) {
		await recordLoginFailure(c.env, normalizedEmail)
		return c.json({ error: "invalid_credentials" }, 401)
	}

	// Transparent rehash kalau iter tersimpan < ITERATIONS saat ini
	if (verifyResult.needsRehash) {
		const newHash = await hashPassword(password)
		await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(newHash, user.id).run()
	}

	await clearLoginThrottle(c.env, normalizedEmail)

	const token = await signJwt(
		{ sub: user.id, email: user.email, role: user.role },
		{
			currentKid: c.env.JWT_KID_CURRENT,
			resolveSecret: defaultKidResolver(c.env as unknown as Record<string, unknown>),
			expiresInSec: SESSION_TTL_SEC,
		}
	)

	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: "Strict",
		path: "/",
		maxAge: SESSION_TTL_SEC,
	})

	return c.json({ id: user.id, email: user.email, role: user.role })
})

app.post("/logout", async (c) => {
	deleteCookie(c, SESSION_COOKIE, { path: "/" })
	return c.json({ ok: true })
})

app.get("/me", userAuth, async (c) => {
	return c.json({
		id: c.get("userId"),
		email: c.get("userEmail"),
		role: c.get("userRole"),
	})
})

export default app
