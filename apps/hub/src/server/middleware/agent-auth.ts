import { createMiddleware } from "hono/factory"
import type { Env } from "../index"
import { sha256Hex } from "../lib/crypto"

export type AgentAuthVars = {
	systemId: string
	tokenHash: string
	systemHost: string
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

	const row = await c.env.DB.prepare(
		"SELECT t.id, t.system_id, t.last_used, s.host FROM agent_tokens t JOIN systems s ON s.id = t.system_id WHERE t.token_hash = ? LIMIT 1"
	)
		.bind(tokenHash)
		.first<{ id: string; system_id: string; last_used: number | null; host: string | null }>()

	if (!row) {
		return c.json({ error: "invalid_token" }, 401)
	}

	c.set("systemId", row.system_id)
	c.set("systemHost", row.host || "")
	c.set("tokenHash", tokenHash)
	const nowSec = Math.floor(Date.now() / 1000)
	if (!row.last_used || row.last_used < nowSec - 3600) {
		const updatePromise = c.env.DB.prepare("UPDATE agent_tokens SET last_used = ? WHERE id = ?")
			.bind(nowSec, row.id)
			.run()
		try {
			c.executionCtx.waitUntil(updatePromise)
		} catch {
			await updatePromise
		}
	}
	await next()
})
