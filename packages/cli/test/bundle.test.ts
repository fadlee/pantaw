import { describe, expect, test } from "bun:test"
import { type Bundle, buildWorkerMetadata, extractBase } from "../src/bundle"
import type { InstanceConfig } from "../src/config"

// Shape of dist/pantaw/wrangler.json as `vite build` writes it.
const built = {
	configPath: "/repo/wrangler.toml",
	name: "pantaw",
	compatibility_date: "2025-01-01",
	compatibility_flags: ["nodejs_compat"],
	rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
	no_bundle: true,
	triggers: { crons: ["*/2 * * * *", "0 2 * * *"] },
	observability: { enabled: true },
	assets: { directory: "../client", binding: "ASSETS", not_found_handling: "single-page-application" },
	vars: { RETENTION_DAYS: "30", TIMEOUT_SECONDS: "90" },
	kv_namespaces: [{ binding: "SESSION_KV", id: "5ef2ea47791b4a90ae84a602638a4198" }],
	d1_databases: [
		{ binding: "DB", database_name: "pantaw", database_id: "70b13a79-b2b1-4148-862f-c12e018a3668" },
	],
	unsafe: {
		bindings: [
			{ name: "INGEST_LIMITER", type: "ratelimit", namespace_id: "1001", simple: { limit: 15, period: 60 } },
		],
	},
}

describe("extractBase", () => {
	test("keeps the Worker settings", () => {
		expect(extractBase(built)).toEqual({
			compatibility_date: "2025-01-01",
			compatibility_flags: ["nodejs_compat"],
			triggers: { crons: ["*/2 * * * *", "0 2 * * *"] },
			observability: { enabled: true },
			not_found_handling: "single-page-application",
			vars: { RETENTION_DAYS: "30", TIMEOUT_SECONDS: "90" },
			ingest_limit: { limit: 15, period: 60 },
		})
	})
	test("drops this checkout's account IDs and paths", () => {
		const text = JSON.stringify(extractBase(built))
		for (const leak of ["5ef2ea47", "70b13a79", "1001", "/repo"]) expect(text).not.toContain(leak)
	})
})

describe("buildWorkerMetadata", () => {
	const bundle: Bundle = {
		worker: "/pkg/bundle/worker/index.js",
		client: "/pkg/bundle/client",
		migrations: "/pkg/bundle/migrations",
		base: extractBase(built),
	}
	const cfg: InstanceConfig = {
		name: "kantor",
		account_id: "acc",
		url: "https://kantor.x.workers.dev",
		d1: { id: "d1-uuid", name: "kantor" },
		kv: { session: "kv-session", rate: "kv-rate" },
		ratelimit_namespace_id: "123456",
		vars: { RETENTION_DAYS: "7" },
		version: "0.4.0",
		created_at: "",
		updated_at: "",
	}
	const meta = buildWorkerMetadata(bundle, cfg, "assets-jwt")

	test("binds the instance's resources", () => {
		expect(meta.main_module).toBe("index.js")
		expect(meta.compatibility_date).toBe("2025-01-01")
		expect(meta.compatibility_flags).toEqual(["nodejs_compat"])
		expect(meta.bindings).toEqual([
			{ type: "assets", name: "ASSETS" },
			{ type: "d1", name: "DB", id: "d1-uuid" },
			{ type: "kv_namespace", name: "SESSION_KV", namespace_id: "kv-session" },
			{ type: "kv_namespace", name: "RATE_KV", namespace_id: "kv-rate" },
			{
				type: "ratelimit",
				name: "INGEST_LIMITER",
				namespace_id: "123456",
				simple: { limit: 15, period: 60 },
			},
			{ type: "plain_text", name: "RETENTION_DAYS", text: "7" },
			{ type: "plain_text", name: "TIMEOUT_SECONDS", text: "90" },
		])
	})
	test("keeps secrets across redeploys", () => {
		expect(meta.keep_bindings).toEqual(["secret_text", "secret_key"])
	})
	test("attaches the assets upload and SPA fallback", () => {
		expect(meta.assets).toEqual({
			jwt: "assets-jwt",
			config: { not_found_handling: "single-page-application" },
		})
		expect(meta.observability).toEqual({ enabled: true })
	})
})
