/**
 * SHA-256 hash dari string, return hex lowercase.
 *
 * Dipakai untuk hash agent token sebelum disimpan/dibandingkan di D1.
 * Token mentah tidak pernah disimpan; lookup pakai hash.
 */
export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input)
	const buf = await crypto.subtle.digest("SHA-256", data)
	const bytes = new Uint8Array(buf)
	let hex = ""
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, "0")
	}
	return hex
}
