import { describe, expect, it } from "vitest"
import { hashPassword, verifyPassword } from "../src/server/lib/password"

describe("password", () => {
	it("hashes a password to PHC string format", async () => {
		const hash = await hashPassword("hunter2")
		expect(hash).toMatch(/^\$pbkdf2-sha256\$i=600000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
	})

	it("produces different hashes for same password (random salt)", async () => {
		const h1 = await hashPassword("hunter2")
		const h2 = await hashPassword("hunter2")
		expect(h1).not.toBe(h2)
	})

	it("verifies correct password", async () => {
		const hash = await hashPassword("hunter2")
		const result = await verifyPassword("hunter2", hash)
		expect(result.valid).toBe(true)
		expect(result.needsRehash).toBe(false)
	})

	it("rejects wrong password", async () => {
		const hash = await hashPassword("hunter2")
		const result = await verifyPassword("hunter3", hash)
		expect(result.valid).toBe(false)
	})

	it("flags needsRehash when stored iter is lower than current", async () => {
		// Construct manual PHC string dengan iter rendah untuk simulasi legacy hash
		const password = "hunter2"
		const salt = crypto.getRandomValues(new Uint8Array(16))
		const enc = new TextEncoder()
		const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
		const bits = await crypto.subtle.deriveBits(
			{ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
			key,
			256
		)
		const b64 = (b: ArrayBuffer | Uint8Array) => {
			const bytes = b instanceof Uint8Array ? b : new Uint8Array(b)
			let bin = ""
			for (const c of bytes) bin += String.fromCharCode(c)
			return btoa(bin)
		}
		const legacy = `$pbkdf2-sha256$i=100000$${b64(salt)}$${b64(bits)}`

		const result = await verifyPassword(password, legacy)
		expect(result.valid).toBe(true)
		expect(result.needsRehash).toBe(true)
	})

	it("rejects malformed PHC string", async () => {
		const result = await verifyPassword("any", "not-a-valid-phc-string")
		expect(result.valid).toBe(false)
		expect(result.needsRehash).toBe(false)
	})

	it("rejects unsupported algorithm", async () => {
		const result = await verifyPassword("any", "$argon2id$v=19$m=65536,t=3,p=4$salt$hash")
		expect(result.valid).toBe(false)
	})

	it("throws on empty password during hash", async () => {
		await expect(hashPassword("")).rejects.toThrow()
	})
})
