import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { InstanceConfig } from "./config"

/**
 * The parts of the built wrangler config that describe the Worker itself —
 * never the account-specific IDs, which come from the instance config.
 */
export interface BaseConfig {
	compatibility_date: string
	compatibility_flags: string[]
	rules: unknown[]
	no_bundle: boolean
	triggers: { crons: string[] }
	observability?: unknown
	not_found_handling?: string
	vars: Record<string, string>
	ingest_limit: { limit: number; period: number }
}

export interface Bundle {
	worker: string
	client: string
	migrations: string
	base: BaseConfig
}

interface BuiltWranglerJson {
	compatibility_date: string
	compatibility_flags?: string[]
	rules?: unknown[]
	no_bundle?: boolean
	triggers?: { crons?: string[] }
	observability?: unknown
	assets?: { not_found_handling?: string }
	vars?: Record<string, string>
	unsafe?: { bindings?: { name: string; simple?: { limit: number; period: number } }[] }
	ratelimits?: { name: string; simple?: { limit: number; period: number } }[]
}

/** Reduce the wrangler.json that `vite build` emits to what every instance shares. */
export function extractBase(built: BuiltWranglerJson): BaseConfig {
	const limiter = [...(built.ratelimits ?? []), ...(built.unsafe?.bindings ?? [])].find(
		(b) => b.name === "INGEST_LIMITER"
	)
	return {
		compatibility_date: built.compatibility_date,
		compatibility_flags: built.compatibility_flags ?? [],
		rules: built.rules ?? [],
		no_bundle: built.no_bundle ?? true,
		triggers: { crons: built.triggers?.crons ?? [] },
		observability: built.observability,
		not_found_handling: built.assets?.not_found_handling,
		vars: built.vars ?? {},
		ingest_limit: limiter?.simple ?? { limit: 15, period: 60 },
	}
}

/**
 * The published package carries the build under bundle/ (see
 * scripts/bundle.ts). Running from a repo checkout, fall back to the root
 * build output so `bun run dev deploy` works after `bun run build`.
 */
export function locateBundle(): Bundle {
	const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
	const packaged = join(pkgRoot, "bundle")
	if (existsSync(join(packaged, "worker", "index.js"))) {
		return {
			worker: join(packaged, "worker", "index.js"),
			client: join(packaged, "client"),
			migrations: join(packaged, "migrations"),
			base: JSON.parse(readFileSync(join(packaged, "worker", "base.json"), "utf8")),
		}
	}
	const repo = join(pkgRoot, "..", "..")
	const built = join(repo, "dist", "pantaw", "wrangler.json")
	if (existsSync(built)) {
		return {
			worker: join(repo, "dist", "pantaw", "index.js"),
			client: join(repo, "dist", "client"),
			migrations: join(repo, "migrations"),
			base: extractBase(JSON.parse(readFileSync(built, "utf8"))),
		}
	}
	throw new Error("Worker bundle not found. In a repo checkout, run `bun run build` first.")
}

/** The wrangler config for one instance, with absolute paths into the bundle. */
export function buildWranglerConfig(bundle: Bundle, cfg: InstanceConfig) {
	const { base } = bundle
	return {
		name: cfg.name,
		main: bundle.worker,
		compatibility_date: base.compatibility_date,
		compatibility_flags: base.compatibility_flags,
		rules: base.rules,
		no_bundle: base.no_bundle,
		workers_dev: true,
		assets: {
			directory: bundle.client,
			binding: "ASSETS",
			...(base.not_found_handling ? { not_found_handling: base.not_found_handling } : {}),
		},
		triggers: base.triggers,
		...(base.observability ? { observability: base.observability } : {}),
		vars: { ...base.vars, ...cfg.vars },
		d1_databases: [
			{
				binding: "DB",
				database_name: cfg.d1.name,
				database_id: cfg.d1.id,
				migrations_dir: bundle.migrations,
			},
		],
		kv_namespaces: [
			{ binding: "SESSION_KV", id: cfg.kv.session },
			{ binding: "RATE_KV", id: cfg.kv.rate },
		],
		// unsafe.bindings rather than `ratelimits`: older wrangler 4 releases drop
		// the latter with only a warning, deploying without the limiter.
		unsafe: {
			bindings: [
				{
					name: "INGEST_LIMITER",
					type: "ratelimit",
					namespace_id: cfg.ratelimit_namespace_id,
					simple: base.ingest_limit,
				},
			],
		},
	}
}
