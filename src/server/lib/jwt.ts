/**
 * JWT helper untuk Pantaw user auth.
 *
 * Algoritma: HS256 (asymmetric tidak diperlukan karena hub adalah satu-
 * satunya signer dan verifier; lihat RFC 8.3).
 *
 * Rotation: header JWT include claim `kid` (key ID). Verifier resolve
 * secret berdasarkan kid. Saat rotasi:
 *   1. Deploy JWT_SECRET_V2 sebagai new env var
 *   2. Set JWT_KID_CURRENT = "v2" → signer pakai V2
 *   3. Verifier accept V1 dan V2 selama 24 jam (= TTL JWT)
 *   4. Hapus JWT_SECRET_V1
 *
 * Helper ini stateless, tidak DB lookup per-verify.
 */

const enc = new TextEncoder()

function bufToB64Url(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
	let bin = ""
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64UrlToBuf(b64url: string): Uint8Array {
	const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4)
	const bin = atob(padded)
	const arr = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
	return arr
}

function b64UrlEncodeJson(value: unknown): string {
	return bufToB64Url(enc.encode(JSON.stringify(value)))
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	)
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data))
	return new Uint8Array(sig)
}

function timingSafeEqualString(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
}

export type UserClaims = {
	sub: string // user id
	email: string
	role: "admin" | "user"
}

export type JwtPayload = UserClaims & {
	iat: number // issued at (unix sec)
	exp: number // expires at (unix sec)
	jti: string // unique token id
}

/**
 * Resolver: kid → secret string. Throw jika kid tidak dikenali.
 *
 * Implementasi default-nya membaca dari env vars dengan pattern
 * `JWT_SECRET_<KID_UPPER>`, mis. kid="v1" → env.JWT_SECRET_V1.
 */
export type KidResolver = (kid: string) => string

export function defaultKidResolver(env: Record<string, unknown>): KidResolver {
	return (kid) => {
		const key = `JWT_SECRET_${kid.toUpperCase()}`
		const value = env[key]
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`unknown_kid:${kid}`)
		}
		return value
	}
}

export type SignOptions = {
	currentKid: string
	resolveSecret: KidResolver
	expiresInSec?: number
}

const DEFAULT_TTL_SEC = 24 * 60 * 60 // 24 jam

/**
 * Sign JWT HS256 dengan claim `kid` di header dan payload `iat`, `exp`, `jti`.
 */
export async function signJwt(claims: UserClaims, opts: SignOptions): Promise<string> {
	const secret = opts.resolveSecret(opts.currentKid)
	const now = Math.floor(Date.now() / 1000)
	const ttl = opts.expiresInSec ?? DEFAULT_TTL_SEC
	const header = { alg: "HS256", typ: "JWT", kid: opts.currentKid }
	const payload: JwtPayload = {
		...claims,
		iat: now,
		exp: now + ttl,
		jti: crypto.randomUUID(),
	}
	const headerB64 = b64UrlEncodeJson(header)
	const payloadB64 = b64UrlEncodeJson(payload)
	const signing = `${headerB64}.${payloadB64}`
	const sig = await hmac(secret, signing)
	return `${signing}.${bufToB64Url(sig)}`
}

export type VerifyOptions = {
	resolveSecret: KidResolver
	/** Override `now` untuk testing. Default Date.now() / 1000. */
	clockSec?: number
}

export type VerifyError = "malformed" | "unknown_kid" | "bad_signature" | "expired" | "not_yet_valid"

export type VerifyResult = { ok: true; payload: JwtPayload; kid: string } | { ok: false; error: VerifyError }

/**
 * Verify JWT signature + expiry. Stateless, tidak DB lookup.
 *
 * Pemanggil bertanggung jawab memutuskan apa yang dilakukan dengan
 * payload (mis. cek role, system access).
 */
export async function verifyJwt(token: string, opts: VerifyOptions): Promise<VerifyResult> {
	const parts = token.split(".")
	if (parts.length !== 3) return { ok: false, error: "malformed" }
	const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

	let header: { alg?: string; kid?: string }
	let payload: JwtPayload
	try {
		header = JSON.parse(new TextDecoder().decode(b64UrlToBuf(headerB64)))
		payload = JSON.parse(new TextDecoder().decode(b64UrlToBuf(payloadB64)))
	} catch {
		return { ok: false, error: "malformed" }
	}

	if (header.alg !== "HS256" || typeof header.kid !== "string") {
		return { ok: false, error: "malformed" }
	}

	let secret: string
	try {
		secret = opts.resolveSecret(header.kid)
	} catch {
		return { ok: false, error: "unknown_kid" }
	}

	const expectedSig = bufToB64Url(await hmac(secret, `${headerB64}.${payloadB64}`))
	if (!timingSafeEqualString(expectedSig, sigB64)) {
		return { ok: false, error: "bad_signature" }
	}

	const now = opts.clockSec ?? Math.floor(Date.now() / 1000)
	if (typeof payload.exp !== "number" || now >= payload.exp) {
		return { ok: false, error: "expired" }
	}
	if (typeof payload.iat === "number" && now + 60 < payload.iat) {
		// agak permisif: izinkan 60s clock skew untuk iat di masa depan
		return { ok: false, error: "not_yet_valid" }
	}

	return { ok: true, payload, kid: header.kid }
}
