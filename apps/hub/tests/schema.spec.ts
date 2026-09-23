import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import migrationSql from "../migrations/0001_initial.sql?raw"
import worker from "../src/server/index"
import { ensureSchema, resetSchemaState } from "../src/server/lib/schema"
import { INITIAL_SCHEMA } from "../src/server/lib/schema"

describe("Auto-migration / schema initialization", () => {
	it("automatically initializes tables on first request", async () => {
		resetSchemaState()

		// Drop all tables to simulate a brand new database
		await env.DB.exec(`
			DROP TABLE IF EXISTS metrics;
			DROP TABLE IF EXISTS alerts;
			DROP TABLE IF EXISTS agent_tokens;
			DROP TABLE IF EXISTS systems;
			DROP TABLE IF EXISTS users;
		`)

		// Verify tables don't exist
		const beforeTables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('systems', 'users', 'metrics', 'alerts', 'agent_tokens')"
		).all<{ name: string }>()
		expect(beforeTables.results).toHaveLength(0)

		// Hit /api/health which triggers the ensureSchema middleware
		const res = await worker.fetch(new Request("http://test/api/health"), env)
		expect(res.status).toBe(200)

		// Verify tables have been automatically created
		const afterTables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('systems', 'users', 'metrics', 'alerts', 'agent_tokens')"
		).all<{ name: string }>()
		expect(afterTables.results.length).toBe(5)
	})

	it("is idempotent when called multiple times", async () => {
		await ensureSchema(env.DB)
		await ensureSchema(env.DB)

		const tables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('systems', 'users', 'metrics', 'alerts', 'agent_tokens')"
		).all<{ name: string }>()
		expect(tables.results.length).toBe(5)
	})

	it("matches migrations/0001_initial.sql strictly to prevent schema drift", () => {
		const normalize = (sql: string) =>
			sql
				.replace(/--.*$/gm, "")
				.replace(/IF NOT EXISTS/gi, "")
				.replace(/\s+/g, " ")
				.replace(/\(\s+/g, "(")
				.replace(/\s+\)/g, ")")
				.replace(/\s*,\s*/g, ", ")
				.trim()
				.toLowerCase()

		const migrationStatements = migrationSql
			.split(";")
			.map((s) => normalize(s))
			.filter((s) => s.length > 0)

		const schemaStatements = INITIAL_SCHEMA.map((s) => normalize(s)).filter((s) => s.length > 0)

		expect(migrationStatements).toEqual(schemaStatements)
	})
})
