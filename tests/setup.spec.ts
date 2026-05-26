import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import worker from "../src/server/index"

async function reset() {
	await env.DB.prepare("DELETE FROM users").run()
}

function setupRequest(body: unknown) {
	return new Request("http://test/api/v1/auth/setup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
}

describe("/api/v1/auth/setup-status", () => {
	beforeEach(reset)
	afterEach(reset)

	it("returns needs_setup=true when users table is empty", async () => {
		const res = await worker.fetch(new Request("http://test/api/v1/auth/setup-status"), env)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { needs_setup: boolean }
		expect(body.needs_setup).toBe(true)
	})

	it("returns needs_setup=false after a user exists", async () => {
		await env.DB.prepare(
			`INSERT INTO users (id, email, password_hash, role, created_at, system_ids)
			 VALUES ('u1', 'a@b.c', 'hash', 'admin', 0, '[]')`
		).run()
		const res = await worker.fetch(new Request("http://test/api/v1/auth/setup-status"), env)
		const body = (await res.json()) as { needs_setup: boolean }
		expect(body.needs_setup).toBe(false)
	})
})

describe("/api/v1/auth/setup", () => {
	beforeEach(reset)
	afterEach(reset)

	it("creates first admin user with auto-login cookie", async () => {
		const res = await worker.fetch(
			setupRequest({ email: "owner@example.com", password: "very-strong-pass" }),
			env
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { id: string; email: string; role: string }
		expect(body.email).toBe("owner@example.com")
		expect(body.role).toBe("admin")
		expect(body.id).toBeTruthy()

		const setCookie = res.headers.get("Set-Cookie")
		expect(setCookie).toContain("HttpOnly")
		expect(setCookie).toContain("SameSite=Strict")

		// Verifikasi user benar-benar tertulis dan password hashed
		const row = await env.DB.prepare("SELECT email, role, password_hash FROM users").first<{
			email: string
			role: string
			password_hash: string
		}>()
		expect(row?.email).toBe("owner@example.com")
		expect(row?.role).toBe("admin")
		expect(row?.password_hash.startsWith("$pbkdf2-sha256$")).toBe(true)
	})

	it("normalizes email to lowercase", async () => {
		const res = await worker.fetch(
			setupRequest({ email: "MIXED@Example.COM", password: "very-strong-pass" }),
			env
		)
		expect(res.status).toBe(201)
		const row = await env.DB.prepare("SELECT email FROM users").first<{ email: string }>()
		expect(row?.email).toBe("mixed@example.com")
	})

	it("rejects when users already exist (409)", async () => {
		await worker.fetch(setupRequest({ email: "first@example.com", password: "very-strong-pass" }), env)

		const second = await worker.fetch(
			setupRequest({ email: "second@example.com", password: "very-strong-pass" }),
			env
		)
		expect(second.status).toBe(409)
		const body = (await second.json()) as { error: string }
		expect(body.error).toBe("already_setup")

		// Pastikan user kedua tidak tertulis
		const count = await env.DB.prepare("SELECT COUNT(*) as n FROM users").first<{ n: number }>()
		expect(count?.n).toBe(1)
	})

	it("rejects short password (< 8)", async () => {
		const res = await worker.fetch(setupRequest({ email: "a@b.c", password: "short" }), env)
		expect(res.status).toBe(400)
	})

	it("rejects invalid email", async () => {
		const res = await worker.fetch(setupRequest({ email: "not-an-email", password: "very-strong-pass" }), env)
		expect(res.status).toBe(400)
	})

	it("session cookie from setup is valid for /me", async () => {
		const setupRes = await worker.fetch(
			setupRequest({ email: "owner@example.com", password: "very-strong-pass" }),
			env
		)
		const cookie = (setupRes.headers.get("Set-Cookie") ?? "").split(";")[0] ?? ""

		const meRes = await worker.fetch(
			new Request("http://test/api/v1/auth/me", { headers: { Cookie: cookie } }),
			env
		)
		expect(meRes.status).toBe(200)
		const me = (await meRes.json()) as { email: string; role: string }
		expect(me.email).toBe("owner@example.com")
		expect(me.role).toBe("admin")
	})

	it("after setup, login with same credentials works", async () => {
		await worker.fetch(setupRequest({ email: "owner@example.com", password: "very-strong-pass" }), env)
		const loginRes = await worker.fetch(
			new Request("http://test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "owner@example.com", password: "very-strong-pass" }),
			}),
			env
		)
		expect(loginRes.status).toBe(200)
	})
})
