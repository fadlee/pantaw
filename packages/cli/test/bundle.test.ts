import { describe, expect, test } from "bun:test"
import { type Bundle, buildWranglerConfig, extractBase } from "../src/bundle"
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
			rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
			no_bundle: true,
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

describe("buildWranglerConfig", () => {
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

	test("binds the instance's resources", () => {
		const w = buildWranglerConfig(bundle, cfg)
		expect(w.name).toBe("kantor")
		expect(w.main).toBe("/pkg/bundle/worker/index.js")
		expect(w.workers_dev).toBe(true)
		expect(w.d1_databases).toEqual([
			{
				binding: "DB",
				database_name: "kantor",
				database_id: "d1-uuid",
				migrations_dir: "/pkg/bundle/migrations",
			},
		])
		expect(w.kv_namespaces).toEqual([
			{ binding: "SESSION_KV", id: "kv-session" },
			{ binding: "RATE_KV", id: "kv-rate" },
		])
		expect(w.unsafe.bindings).toEqual([
			{ name: "INGEST_LIMITER", type: "ratelimit", namespace_id: "123456", simple: { limit: 15, period: 60 } },
		])
		expect(w.assets).toEqual({
			directory: "/pkg/bundle/client",
			binding: "ASSETS",
			not_found_handling: "single-page-application",
		})
	})
	test("instance vars override defaults, new defaults still arrive", () => {
		expect(buildWranglerConfig(bundle, cfg).vars).toEqual({ RETENTION_DAYS: "7", TIMEOUT_SECONDS: "90" })
	})
})
