import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Everything needed to redeploy an instance without asking again. One file
 * per instance, named after the Worker: ~/.config/pantaw/<name>.json.
 */
export interface InstanceConfig {
	name: string
	account_id: string
	account_name?: string
	url: string
	d1: { id: string; name: string }
	kv: { session: string; rate: string }
	ratelimit_namespace_id: string
	vars: Record<string, string>
	/** Only present when the user agreed to save it. */
	api_token?: string
	/** CLI version that last deployed this instance. */
	version: string
	created_at: string
	updated_at: string
}

export function configDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "pantaw")
}

export function configPath(dir: string, name: string): string {
	return join(dir, `${name}.json`)
}

/**
 * The instance name becomes the Worker name and the workers.dev subdomain
 * label, so it follows the stricter of the two: a DNS label.
 */
export function validateName(name: string): string | undefined {
	if (!name) return "Name is required"
	if (name.length > 63) return "At most 63 characters"
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
		return "Lowercase letters, digits and dashes; must start and end with a letter or digit"
	}
	return undefined
}

export function resourceNames(name: string) {
	return {
		worker: name,
		d1: name,
		kvSession: `${name}-session`,
		kvRate: `${name}-rate`,
	}
}

/**
 * Rate-limit namespaces are numbered per account, and every Worker binding the
 * same number shares its counters. Deriving the number from the instance name
 * keeps two instances (or another project that picked 1001) apart.
 */
export function ratelimitNamespaceId(name: string): string {
	let h = 0x811c9dc5
	for (let i = 0; i < name.length; i++) {
		h ^= name.charCodeAt(i)
		h = Math.imul(h, 0x01000193) >>> 0
	}
	return String(100_000 + (h % 900_000))
}

export async function loadConfig(dir: string, name: string): Promise<InstanceConfig | null> {
	try {
		return JSON.parse(await readFile(configPath(dir, name), "utf8")) as InstanceConfig
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
		throw err
	}
}

export async function saveConfig(dir: string, cfg: InstanceConfig): Promise<string> {
	await mkdir(dir, { recursive: true, mode: 0o700 })
	const path = configPath(dir, cfg.name)
	await writeFile(path, `${JSON.stringify(cfg, null, "\t")}\n`, { mode: 0o600 })
	// writeFile's mode only applies on create; an older file keeps its mode.
	await chmod(path, 0o600)
	return path
}

export async function listConfigs(dir: string): Promise<InstanceConfig[]> {
	let files: string[]
	try {
		files = await readdir(dir)
	} catch {
		return []
	}
	const configs: InstanceConfig[] = []
	for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
		try {
			configs.push(JSON.parse(await readFile(join(dir, f), "utf8")) as InstanceConfig)
		} catch {
			// A corrupt file must not hide the others.
		}
	}
	return configs
}

export async function removeConfig(dir: string, name: string): Promise<void> {
	await rm(configPath(dir, name), { force: true })
}
