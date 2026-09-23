import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "../src/server/index"

describe("/api/health", () => {
	it("returns ok with db check passing", async () => {
		const res = await worker.fetch(new Request("http://test/api/health"), env)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			status: string
			service: string
			timestamp: string
			checks: { db: boolean }
			latency_ms: number
		}
		expect(body.status).toBe("ok")
		expect(body.service).toBe("pantaw")
		expect(body.checks.db).toBe(true)
		expect(typeof body.latency_ms).toBe("number")
		expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date")
	})

	it("redirects /api/v1/health to /api/health", async () => {
		const res = await worker.fetch(new Request("http://test/api/v1/health", { redirect: "manual" }), env)
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/api/health")
	})
})
