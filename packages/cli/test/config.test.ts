import { describe, expect, test } from "bun:test"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type InstanceConfig,
	configDir,
	listConfigs,
	loadConfig,
	ratelimitNamespaceId,
	resourceNames,
	saveConfig,
	validateName,
} from "../src/config"

const sample = (name: string): InstanceConfig => ({
	name,
	account_id: "acc",
	url: `https://${name}.example.workers.dev`,
	d1: { id: "d1-id", name },
	kv: { session: "kv-s", rate: "kv-r" },
	ratelimit_namespace_id: ratelimitNamespaceId(name),
	vars: {},
	version: "0.0.0",
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
})

describe("configDir", () => {
	test("defaults to ~/.config/pantaw", () => {
		expect(configDir({}, "/home/u")).toBe("/home/u/.config/pantaw")
	})
	test("follows XDG_CONFIG_HOME", () => {
		expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/pantaw")
	})
})

describe("validateName", () => {
	test.each(["pantaw", "pantaw-staging", "a", "x1"])("accepts %s", (n) => {
		expect(validateName(n)).toBeUndefined()
	})
	test.each(["", "Pantaw", "-a", "a-", "a_b", "a.b", "x".repeat(64)])("rejects %p", (n) => {
		expect(validateName(n)).toBeString()
	})
})

describe("resourceNames", () => {
	test("derives every resource from the instance name", () => {
		expect(resourceNames("kantor")).toEqual({
			worker: "kantor",
			d1: "kantor",
			kvSession: "kantor-session",
			kvRate: "kantor-rate",
		})
	})
})

describe("ratelimitNamespaceId", () => {
	test("is a stable six-digit integer", () => {
		const id = ratelimitNamespaceId("pantaw")
		expect(id).toMatch(/^[1-9]\d{5}$/)
		expect(ratelimitNamespaceId("pantaw")).toBe(id)
	})
	test("differs between instances", () => {
		expect(ratelimitNamespaceId("pantaw")).not.toBe(ratelimitNamespaceId("pantaw-staging"))
	})
})

describe("save/load/list", () => {
	test("round-trips with owner-only permissions", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "pantaw-test-")), "nested")
		const path = await saveConfig(dir, { ...sample("a"), api_token: "secret" })
		expect((await stat(path)).mode & 0o777).toBe(0o600)
		expect((await loadConfig(dir, "a"))?.api_token).toBe("secret")
		expect(await loadConfig(dir, "missing")).toBeNull()
	})
	test("lists sorted and skips corrupt files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pantaw-test-"))
		await saveConfig(dir, sample("b"))
		await saveConfig(dir, sample("a"))
		await writeFile(join(dir, "broken.json"), "{")
		expect((await listConfigs(dir)).map((c) => c.name)).toEqual(["a", "b"])
	})
	test("lists nothing when the directory is missing", async () => {
		expect(await listConfigs("/nonexistent/pantaw")).toEqual([])
	})
})
