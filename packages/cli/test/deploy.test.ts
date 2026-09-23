import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bundle } from "../src/bundle"
import {
	assetHash,
	collectAssets,
	contentType,
	deployWorker,
	migrationSql,
	pendingMigrations,
} from "../src/deploy"

describe("pendingMigrations", () => {
	test("returns unapplied .sql files in order", () => {
		expect(pendingMigrations(["0002_b.sql", "README.md", "0001_a.sql", "0003_c.sql"], ["0001_a.sql"])).toEqual([
			"0002_b.sql",
			"0003_c.sql",
		])
	})
	test("is empty when everything ran", () => {
		expect(pendingMigrations(["0001_a.sql"], ["0001_a.sql"])).toEqual([])
	})
})

describe("migrationSql", () => {
	test("records the migration in the same request", () => {
		expect(migrationSql("0001_initial.sql", "CREATE TABLE t (id INT);\n")).toBe(
			"CREATE TABLE t (id INT);\nINSERT INTO d1_migrations (name) VALUES ('0001_initial.sql');"
		)
	})
	test("terminates a last statement without a semicolon", () => {
		expect(migrationSql("0002_x.sql", "CREATE INDEX i ON t (id)")).toStartWith("CREATE INDEX i ON t (id);\n")
	})
	test("rejects names that would need quoting", () => {
		expect(() => migrationSql("0003_it's.sql", "")).toThrow()
	})
})

describe("assets", () => {
	test("hash is 32 hex chars and depends on the extension", () => {
		const body = Buffer.from("hello")
		expect(assetHash(body, "/a.js")).toMatch(/^[0-9a-f]{32}$/)
		expect(assetHash(body, "/a.js")).not.toBe(assetHash(body, "/a.css"))
		expect(assetHash(body, "/x/a.js")).toBe(assetHash(body, "/y/b.js"))
	})
	test("contentType covers the SPA's files", () => {
		expect(contentType("index.html")).toBe("text/html")
		expect(contentType("assets/index-abc.js")).toBe("application/javascript")
		expect(contentType("font.WOFF2")).toBe("font/woff2")
		expect(contentType("blob.bin")).toBe("application/octet-stream")
	})
	test("collectAssets walks subdirectories with URL paths", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pantaw-assets-"))
		await mkdir(join(dir, "assets", "nested"), { recursive: true })
		await writeFile(join(dir, "index.html"), "<html></html>")
		await writeFile(join(dir, "assets", "nested", "app.js"), "x")
		const assets = await collectAssets(dir)
		expect(assets.map((a) => [a.path, a.size])).toEqual([
			["/assets/nested/app.js", 1],
			["/index.html", 13],
		])
	})
})

describe("deployWorker", () => {
	test("uploads missing assets, then the script, crons and workers.dev route", async () => {
		const client = await mkdtemp(join(tmpdir(), "pantaw-client-"))
		await writeFile(join(client, "index.html"), "<html></html>")
		await writeFile(join(client, "app.js"), "console.log(1)")
		const worker = join(client, "..", `worker-${Date.now()}.js`)
		await writeFile(worker, "export default {}")
		const bundle: Bundle = {
			worker,
			client,
			migrations: "",
			base: {
				compatibility_date: "2025-01-01",
				compatibility_flags: [],
				triggers: { crons: ["*/2 * * * *"] },
				vars: {},
				ingest_limit: { limit: 15, period: 60 },
			},
		}
		const cfg = {
			name: "demo",
			account_id: "acc",
			url: "",
			d1: { id: "d1", name: "demo" },
			kv: { session: "s", rate: "r" },
			ratelimit_namespace_id: "1",
			vars: {},
			version: "",
			created_at: "",
			updated_at: "",
		}
		const htmlHash = assetHash(Buffer.from("<html></html>"), "index.html")

		const calls: { method: string; url: string; auth: string | null; body: unknown }[] = []
		const realFetch = globalThis.fetch
		globalThis.fetch = (async (input: string, init: RequestInit) => {
			const url = input.replace("https://api.cloudflare.com/client/v4", "")
			const auth = new Headers(init.headers).get("Authorization")
			calls.push({ method: init.method ?? "GET", url, auth, body: init.body })
			const ok = (result: unknown, status = 200) =>
				new Response(JSON.stringify({ success: true, result }), { status })
			if (url.endsWith("/assets-upload-session")) return ok({ jwt: "upload-jwt", buckets: [[htmlHash]] })
			if (url.includes("/workers/assets/upload")) return ok({ jwt: "done-jwt" }, 201)
			return ok({})
		}) as typeof fetch
		try {
			expect(await deployWorker("tok", "acc", bundle, cfg)).toEqual({ assets: 2, uploaded: 1 })
		} finally {
			globalThis.fetch = realFetch
		}

		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"POST /accounts/acc/workers/scripts/demo/assets-upload-session",
			"POST /accounts/acc/workers/assets/upload?base64=true",
			"PUT /accounts/acc/workers/scripts/demo",
			"PUT /accounts/acc/workers/scripts/demo/schedules",
			"POST /accounts/acc/workers/scripts/demo/subdomain",
		])
		const [session, upload, script, schedules] = calls
		expect(Object.keys(JSON.parse(session?.body as string).manifest)).toEqual(["/app.js", "/index.html"])
		// The bucket upload authenticates with the session's JWT, not the API token.
		expect(upload?.auth).toBe("Bearer upload-jwt")
		const uploaded = upload?.body as FormData
		expect(await (uploaded.get(htmlHash) as File).text()).toBe(Buffer.from("<html></html>").toString("base64"))

		const form = script?.body as FormData
		const metadata = JSON.parse(await (form.get("metadata") as Blob).text())
		expect(metadata.assets.jwt).toBe("done-jwt")
		expect((form.get("index.js") as File).type).toBe("application/javascript+module")
		expect(await (form.get("index.js") as File).text()).toBe("export default {}")
		expect(JSON.parse(schedules?.body as string)).toEqual([{ cron: "*/2 * * * *" }])
	})
})
