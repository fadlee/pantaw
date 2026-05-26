import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import worker from "../src/server/index"
import { hashPassword } from "../src/server/lib/password"

const ADMIN_USER = {
	id: "user_admin",
	email: "admin@example.com",
	password: "hunter2-very-strong-password",
	role: "admin" as const,
}

async function createUser(opts = ADMIN_USER) {
	const hash = await hashPassword(opts.password)
	const now = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		`INSERT OR REPLACE INTO users (id, email, password_hash, role, created_at, system_ids)
		 VALUES (?, ?, ?, ?, ?, ?)`
	)
		.bind(opts.id, opts.email, hash, opts.role, now, "[]")
		.run()
}

async function reset() {
	await env.DB.prepare("DELETE FROM users").run()
	// Bersihkan throttle key juga
	const list = await env.RATE_KV.list({ prefix: "login:" })
	await Promise.all(list.keys.map((k) => env.RATE_KV.delete(k.name)))
}

function loginRequest(body: unknown) {
	return new Request("http://test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
}

function meRequest(cookieHeader: string) {
	return new Request("http://test/api/v1/auth/me", {
		method: "GET",
		headers: { Cookie: cookieHeader },
	})
}

function getSessionCookie(setCookie: string | null): string {
	expect(setCookie).toBeTruthy()
	const cookieValue = setCookie?.split(";")[0] ?? ""
	expect(cookieValue.startsWith("pantaw_session=")).toBe(true)
	return cookieValue
}

describe("/api/v1/auth", () => {
	beforeEach(async () => {
		await reset()
		await createUser()
	})

	afterEach(async () => {
		await reset()
	})

	it("login: returns 401 for unknown email", async () => {
		const res = await worker.fetch(loginRequest({ email: "nope@example.com", password: "whatever" }), env)
		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: string }
		expect(body.error).toBe("invalid_credentials")
	})

	it("login: returns 401 for wrong password", async () => {
		const res = await worker.fetch(loginRequest({ email: ADMIN_USER.email, password: "wrong" }), env)
		expect(res.status).toBe(401)
	})

	it("login: returns 400 for malformed body (missing fields)", async () => {
		const res = await worker.fetch(loginRequest({ email: "x@y.com" }), env)
		expect(res.status).toBe(400)
	})

	it("login: returns 400 for invalid email format", async () => {
		const res = await worker.fetch(loginRequest({ email: "not-an-email", password: "x" }), env)
		expect(res.status).toBe(400)
	})

	it("login: succeeds with valid credentials and sets HttpOnly cookie", async () => {
		const res = await worker.fetch(
			loginRequest({ email: ADMIN_USER.email, password: ADMIN_USER.password }),
			env
		)
		expect(res.status).toBe(200)
		const setCookie = res.headers.get("Set-Cookie")
		expect(setCookie).toBeTruthy()
		expect(setCookie).toContain("HttpOnly")
		// Secure flag hanya di-set saat HTTPS — di test pakai http://test/ jadi tidak ada
		expect(setCookie).toContain("SameSite=Strict")
		expect(setCookie).toContain("Path=/")
		expect(setCookie).toContain("Path=/")
		const body = (await res.json()) as { id: string; email: string; role: string }
		expect(body.email).toBe(ADMIN_USER.email)
		expect(body.role).toBe("admin")
	})

	it("login: email lookup is case-insensitive", async () => {
		const res = await worker.fetch(
			loginRequest({ email: "ADMIN@example.com", password: ADMIN_USER.password }),
			env
		)
		expect(res.status).toBe(200)
	})

	it("login: throttles after 5 failed attempts (per email)", async () => {
		const attempt = () => worker.fetch(loginRequest({ email: ADMIN_USER.email, password: "wrong" }), env)

		for (let i = 0; i < 5; i++) {
			const res = await attempt()
			expect(res.status).toBe(401)
		}
		// 6th attempt should be throttled
		const sixth = await attempt()
		expect(sixth.status).toBe(429)
		expect(sixth.headers.get("Retry-After")).toBeTruthy()
	})

	it("login: successful login clears throttle counter", async () => {
		// 3 failed attempts
		for (let i = 0; i < 3; i++) {
			await worker.fetch(loginRequest({ email: ADMIN_USER.email, password: "wrong" }), env)
		}
		// Successful login
		const ok = await worker.fetch(loginRequest({ email: ADMIN_USER.email, password: ADMIN_USER.password }), env)
		expect(ok.status).toBe(200)

		// Now 5 more failed attempts should still work (counter was reset)
		for (let i = 0; i < 5; i++) {
			const res = await worker.fetch(loginRequest({ email: ADMIN_USER.email, password: "wrong" }), env)
			expect(res.status).toBe(401)
		}
	})

	it("me: returns 401 without cookie", async () => {
		const res = await worker.fetch(new Request("http://test/api/v1/auth/me", { method: "GET" }), env)
		expect(res.status).toBe(401)
	})

	it("me: returns user info with valid session cookie", async () => {
		const loginRes = await worker.fetch(
			loginRequest({ email: ADMIN_USER.email, password: ADMIN_USER.password }),
			env
		)
		const cookie = getSessionCookie(loginRes.headers.get("Set-Cookie"))

		const meRes = await worker.fetch(meRequest(cookie), env)
		expect(meRes.status).toBe(200)
		const body = (await meRes.json()) as { id: string; email: string; role: string }
		expect(body.id).toBe(ADMIN_USER.id)
		expect(body.email).toBe(ADMIN_USER.email)
		expect(body.role).toBe("admin")
	})

	it("me: returns 401 for tampered cookie", async () => {
		const res = await worker.fetch(meRequest("pantaw_session=not.a.valid.jwt.at.all"), env)
		expect(res.status).toBe(401)
	})

	it("logout: clears session cookie", async () => {
		const loginRes = await worker.fetch(
			loginRequest({ email: ADMIN_USER.email, password: ADMIN_USER.password }),
			env
		)
		const cookie = getSessionCookie(loginRes.headers.get("Set-Cookie"))

		const logoutRes = await worker.fetch(
			new Request("http://test/api/v1/auth/logout", {
				method: "POST",
				headers: { Cookie: cookie },
			}),
			env
		)
		expect(logoutRes.status).toBe(200)
		const setCookie = logoutRes.headers.get("Set-Cookie") ?? ""
		// Cookie cleared = Max-Age=0 atau expired date
		expect(setCookie).toMatch(/Max-Age=0|Expires=/)
	})
})
