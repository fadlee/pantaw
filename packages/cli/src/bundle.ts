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

/**
 * Metadata for the Workers script upload API: what wrangler would derive
 * from a wrangler.json, with this instance's resource IDs bound in.
 */
export function buildWorkerMetadata(bundle: Bundle, cfg: InstanceConfig, assetsJwt: string) {
	const { base } = bundle
	const vars = { ...base.vars, ...cfg.vars }
	return {
		main_module: "index.js",
		compatibility_date: base.compatibility_date,
		compatibility_flags: base.compatibility_flags,
		bindings: [
			{ type: "assets", name: "ASSETS" },
			{ type: "d1", name: "DB", id: cfg.d1.id },
			{ type: "kv_namespace", name: "SESSION_KV", namespace_id: cfg.kv.session },
			{ type: "kv_namespace", name: "RATE_KV", namespace_id: cfg.kv.rate },
			{
				type: "ratelimit",
				name: "INGEST_LIMITER",
				namespace_id: cfg.ratelimit_namespace_id,
				simple: base.ingest_limit,
			},
			...Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })),
		],
		// A script upload replaces every binding it does not list; secrets are
		// set separately and must survive redeploys.
		keep_bindings: ["secret_text", "secret_key"],
		assets: {
			jwt: assetsJwt,
			...(base.not_found_handling ? { config: { not_found_handling: base.not_found_handling } } : {}),
		},
		...(base.observability ? { observability: base.observability } : {}),
	}
}
