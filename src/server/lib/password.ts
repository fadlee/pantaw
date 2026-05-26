/**
 * Password hashing menggunakan PBKDF2-SHA256 via WebCrypto.
 *
 * Lihat RFC section 8.3:
 * - Iterations: 600.000 (rekomendasi OWASP 2023)
 * - Salt: 16 bytes random per password
 * - Output: 32 bytes derived key
 * - PHC string format untuk forward compatibility
 *
 * Pilihan PBKDF2 di atas bcrypt karena bcrypt cost ≥10 melebihi
 * CPU limit 10ms Workers free tier. PBKDF2 native via WebCrypto
 * (BoringSSL) tetap muat dalam budget.
 */

const ITERATIONS = 600_000
const HASH_LEN = 32
const SALT_LEN = 16

const enc = new TextEncoder()

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
	let bin = ""
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin)
}

function b64ToBuf(b64: string): Uint8Array {
	const bin = atob(b64)
	const arr = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
	return arr
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
		key,
		HASH_LEN * 8
	)
	return new Uint8Array(bits)
}

/**
 * Hash password baru menggunakan iteration count saat ini.
 *
 * Output format PHC: `$pbkdf2-sha256$i=<iter>$<base64-salt>$<base64-hash>`
 */
export async function hashPassword(password: string): Promise<string> {
	if (!password || password.length === 0) {
		throw new Error("password must not be empty")
	}
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
	const hash = await derive(password, salt, ITERATIONS)
	return `$pbkdf2-sha256$i=${ITERATIONS}$${bufToB64(salt)}$${bufToB64(hash)}`
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: bounds checked above
		diff |= a[i]! ^ b[i]!
	}
	return diff === 0
}

export type VerifyResult = {
	valid: boolean
	/** True jika hash tersimpan pakai iteration < ITERATIONS saat ini.
	 *  Caller boleh re-hash + update DB untuk transparent upgrade. */
	needsRehash: boolean
}

/**
 * Verify password terhadap stored PHC string. Return juga flag needsRehash
 * untuk transparent upgrade saat OWASP menaikkan rekomendasi iteration.
 */
export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
	const parts = stored.split("$")
	// Format: ["", "pbkdf2-sha256", "i=600000", salt, hash]
	if (parts.length !== 5 || parts[1] !== "pbkdf2-sha256") {
		return { valid: false, needsRehash: false }
	}
	const iterPart = parts[2] ?? ""
	if (!iterPart.startsWith("i=")) {
		return { valid: false, needsRehash: false }
	}
	const iter = Number.parseInt(iterPart.slice(2), 10)
	if (!Number.isFinite(iter) || iter <= 0) {
		return { valid: false, needsRehash: false }
	}
	let salt: Uint8Array
	let expected: Uint8Array
	try {
		salt = b64ToBuf(parts[3] ?? "")
		expected = b64ToBuf(parts[4] ?? "")
	} catch {
		return { valid: false, needsRehash: false }
	}
	const actual = await derive(password, salt, iter)
	const valid = timingSafeEqual(actual, expected)
	return { valid, needsRehash: valid && iter < ITERATIONS }
}
