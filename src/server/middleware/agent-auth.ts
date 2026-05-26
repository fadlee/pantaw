import { createMiddleware } from "hono/factory"
import type { Env } from "../index"
import { sha256Hex } from "../lib/crypto"

export type AgentAuthVars = {
	systemId: string
	tokenHash: string
}

/**
 * Verifikasi Bearer token dari header Authorization.
 *
 * Jika valid, set context vars `systemId` dan `tokenHash` untuk dipakai
 * downstream handler. Jika tidak, return 401.
 *
 * Token mentah di-hash SHA-256 dan dilookup di tabel `agent_tokens`.
 */
export const agentAuth = createMiddleware<{ Bindings: Env; Variables: AgentAuthVars }>(async (c, next) => {
	const authz = c.req.header("Authorization")
	if (!authz || !authz.startsWith("Bearer ")) {
		return c.json({ error: "missing_bearer_token" }, 401)
	}
	const token = authz.slice("Bearer ".length).trim()
	if (token.length === 0) {
		return c.json({ error: "missing_bearer_token" }, 401)
	}

	const tokenHash = await sha256Hex(token)

	const row = await c.env.DB.prepare("SELECT system_id FROM agent_tokens WHERE token_hash = ? LIMIT 1")
		.bind(tokenHash)
		.first<{ system_id: string }>()

	if (!row) {
		return c.json({ error: "invalid_token" }, 401)
	}

	c.set("systemId", row.system_id)
	c.set("tokenHash", tokenHash)
	await next()
})
