import { describe, expect, it } from "vitest"
import { defaultKidResolver, signJwt, verifyJwt } from "../src/server/lib/jwt"

const env = {
	JWT_SECRET_V1: "secret-v1-very-long-and-random-string",
	JWT_SECRET_V2: "secret-v2-also-very-long-and-random-string",
}

const claims = {
	sub: "user_1",
	email: "admin@example.com",
	role: "admin" as const,
}

describe("jwt", () => {
	it("signs and verifies a valid token", async () => {
		const resolve = defaultKidResolver(env)
		const token = await signJwt(claims, { currentKid: "v1", resolveSecret: resolve })

		const result = await verifyJwt(token, { resolveSecret: resolve })
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.kid).toBe("v1")
			expect(result.payload.sub).toBe("user_1")
			expect(result.payload.email).toBe("admin@example.com")
			expect(result.payload.role).toBe("admin")
			expect(result.payload.exp).toBeGreaterThan(result.payload.iat)
			expect(result.payload.jti).toMatch(/^[0-9a-f-]{36}$/i)
		}
	})

	it("rejects malformed token", async () => {
		const resolve = defaultKidResolver(env)
		const result = await verifyJwt("not.a.jwt", { resolveSecret: resolve })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toBe("malformed")
	})

	it("rejects token signed with unknown kid", async () => {
		// Sign dengan kid v3 yang tidak ada di env
		const resolve = defaultKidResolver({ JWT_SECRET_V3: "tmp-secret" })
		const token = await signJwt(claims, { currentKid: "v3", resolveSecret: resolve })

		const verifyResolve = defaultKidResolver(env) // tidak punya v3
		const result = await verifyJwt(token, { resolveSecret: verifyResolve })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toBe("unknown_kid")
	})

	it("rejects token with tampered signature", async () => {
		const resolve = defaultKidResolver(env)
		const token = await signJwt(claims, { currentKid: "v1", resolveSecret: resolve })
		const [h, p] = token.split(".")
		const tampered = `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`

		const result = await verifyJwt(tampered, { resolveSecret: resolve })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toBe("bad_signature")
	})

	it("rejects token signed with wrong secret (kid swap attack)", async () => {
		// Token disign dengan v1, tapi attacker ubah header jadi v2 (yang punya secret beda)
		const resolve = defaultKidResolver(env)
		const token = await signJwt(claims, { currentKid: "v1", resolveSecret: resolve })

		// Ubah header.kid jadi v2 manually
		const [_h, p, s] = token.split(".") as [string, string, string]
		const tamperedHeader = btoa(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "v2" }))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "")
		const tampered = `${tamperedHeader}.${p}.${s}`

		const result = await verifyJwt(tampered, { resolveSecret: resolve })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toBe("bad_signature")
	})

	it("supports rotation: token v1 still valid while signer moved to v2", async () => {
		const resolve = defaultKidResolver(env)
		const oldToken = await signJwt(claims, { currentKid: "v1", resolveSecret: resolve })

		// Simulasi: signer baru pakai v2, tapi verifier masih accept kedua secret
		const newToken = await signJwt(claims, { currentKid: "v2", resolveSecret: resolve })

		const oldResult = await verifyJwt(oldToken, { resolveSecret: resolve })
		const newResult = await verifyJwt(newToken, { resolveSecret: resolve })
		expect(oldResult.ok).toBe(true)
		expect(newResult.ok).toBe(true)
		if (oldResult.ok && newResult.ok) {
			expect(oldResult.kid).toBe("v1")
			expect(newResult.kid).toBe("v2")
		}
	})

	it("rejects expired token", async () => {
		const resolve = defaultKidResolver(env)
		const token = await signJwt(claims, {
			currentKid: "v1",
			resolveSecret: resolve,
			expiresInSec: 1,
		})

		const future = Math.floor(Date.now() / 1000) + 10
		const result = await verifyJwt(token, { resolveSecret: resolve, clockSec: future })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error).toBe("expired")
	})
})
