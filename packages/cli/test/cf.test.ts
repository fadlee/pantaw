import { describe, expect, test } from "bun:test"
import { parseBindings, tokenCreateUrl } from "../src/cf"

describe("parseBindings", () => {
	test("maps a Worker deployed from wrangler.toml", () => {
		const parsed = parseBindings([
			{ type: "d1", name: "DB", id: "70b13a79" },
			{ type: "kv_namespace", name: "SESSION_KV", namespace_id: "5ef2" },
			{ type: "kv_namespace", name: "RATE_KV", namespace_id: "4e22" },
			{ type: "ratelimit", name: "INGEST_LIMITER", namespace_id: "1001" },
			{ type: "plain_text", name: "RETENTION_DAYS", text: "14" },
			{ type: "secret_text", name: "JWT_SECRET_V1" },
			{ type: "assets", name: "ASSETS" },
		])
		expect(parsed).toEqual({
			d1Id: "70b13a79",
			kvSession: "5ef2",
			kvRate: "4e22",
			ratelimitNamespaceId: "1001",
			vars: { RETENTION_DAYS: "14" },
		})
	})
	test("leaves missing bindings undefined so they get provisioned", () => {
		expect(parseBindings([])).toEqual({ vars: {} })
	})
	test("ignores bindings with other names", () => {
		expect(parseBindings([{ type: "d1", name: "OTHER", id: "x" }]).d1Id).toBeUndefined()
	})
})

describe("tokenCreateUrl", () => {
	test("pre-selects exactly the permissions the CLI uses", () => {
		const url = new URL(tokenCreateUrl())
		expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens")
		const keys = JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]")
		expect(keys).toEqual([
			{ key: "workers_scripts", type: "edit" },
			{ key: "d1", type: "edit" },
			{ key: "workers_kv_storage", type: "edit" },
		])
	})
})
