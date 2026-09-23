import { describe, expect, test } from "bun:test"
import { agentInstallCommand, sessionCookie } from "../src/hub"

describe("sessionCookie", () => {
	test("picks the session cookie out of Set-Cookie", () => {
		const h = new Headers()
		h.append("Set-Cookie", "other=1; Path=/")
		h.append("Set-Cookie", "pantaw_session=abc.def; Path=/; HttpOnly; SameSite=Strict")
		expect(sessionCookie(h)).toBe("pantaw_session=abc.def")
	})
	test("is undefined without one", () => {
		expect(sessionCookie(new Headers())).toBeUndefined()
	})
})

test("agentInstallCommand passes hub URL and token to the installer", () => {
	expect(agentInstallCommand("https://p.x.workers.dev", "tok")).toBe(
		"curl -sSL https://raw.githubusercontent.com/fadlee/pantaw/main/install-agent.sh | sudo bash -s -- -u https://p.x.workers.dev -t tok"
	)
})
