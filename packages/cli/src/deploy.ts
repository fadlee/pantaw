/**
 * Migrate and deploy through the Cloudflare API directly — what wrangler
 * would do for this Worker, without shipping wrangler (and its 200 MB of
 * local-dev runtime) to everyone who runs `bunx pantaw`.
 */
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { extname, join, relative, sep } from "node:path"
import { type Bundle, buildWorkerMetadata } from "./bundle"
import {
	type AssetManifestEntry,
	d1Query,
	enableWorkersDev,
	putCronTriggers,
	putWorkerScript,
	startAssetsUpload,
	uploadAssetsBucket,
} from "./cf"
import type { InstanceConfig } from "./config"

// ------------------------------------------------------------------ migrations

/**
 * Same table wrangler keeps, so `wrangler d1 migrations apply` and this CLI
 * agree on what has run — including on databases migrated before the CLI.
 */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT UNIQUE,
	applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`

export function pendingMigrations(files: string[], applied: string[]): string[] {
	const done = new Set(applied)
	return files.filter((f) => f.endsWith(".sql") && !done.has(f)).sort()
}

/** A migration and its bookkeeping row, sent as one request. */
export function migrationSql(name: string, sql: string): string {
	if (!/^[\w.-]+$/.test(name)) throw new Error(`Unexpected migration file name: ${name}`)
	const body = sql.trim()
	return `${body}${body.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${name}');`
}

export async function applyMigrations(
	token: string,
	accountId: string,
	databaseId: string,
	dir: string
): Promise<string[]> {
	const [, rows] = await d1Query<{ name: string }>(
		token,
		accountId,
		databaseId,
		`${MIGRATIONS_TABLE}\nSELECT name FROM d1_migrations;`
	)
	const pending = pendingMigrations(
		await readdir(dir),
		(rows?.results ?? []).map((r) => r.name)
	)
	for (const name of pending) {
		await d1Query(token, accountId, databaseId, migrationSql(name, await readFile(join(dir, name), "utf8")))
	}
	return pending
}

// ------------------------------------------------------------------ assets

const CONTENT_TYPES: Record<string, string> = {
	html: "text/html",
	js: "application/javascript",
	mjs: "application/javascript",
	css: "text/css",
	json: "application/json",
	map: "application/json",
	webmanifest: "application/manifest+json",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	txt: "text/plain",
	xml: "application/xml",
	wasm: "application/wasm",
}

export function contentType(path: string): string {
	return CONTENT_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream"
}

/**
 * 32 hex chars over the base64 body plus extension, as in Cloudflare's
 * direct-upload docs. Wrangler uses blake3 instead; the API only needs the
 * hash to be stable, so the first deploy after wrangler re-uploads once.
 */
export function assetHash(content: Buffer, path: string): string {
	return createHash("sha256")
		.update(content.toString("base64") + extname(path).slice(1))
		.digest("hex")
		.slice(0, 32)
}

export interface Asset extends AssetManifestEntry {
	/** URL path, e.g. /assets/index-abc.js */
	path: string
	file: string
}

async function walk(dir: string): Promise<string[]> {
	const files: string[] = []
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) files.push(...(await walk(path)))
		else if (entry.isFile()) files.push(path)
	}
	return files
}

export async function collectAssets(dir: string): Promise<Asset[]> {
	const assets: Asset[] = []
	for (const file of await walk(dir)) {
		const content = await readFile(file)
		assets.push({
			path: `/${relative(dir, file).split(sep).join("/")}`,
			file,
			hash: assetHash(content, file),
			size: content.length,
		})
	}
	return assets.sort((a, b) => a.path.localeCompare(b.path))
}

/** Upload whatever Cloudflare does not have yet; returns the completion token. */
async function uploadAssets(
	token: string,
	accountId: string,
	worker: string,
	assets: Asset[]
): Promise<{ jwt: string; uploaded: number }> {
	const manifest = Object.fromEntries(assets.map((a) => [a.path, { hash: a.hash, size: a.size }]))
	const session = await startAssetsUpload(token, accountId, worker, manifest)
	const byHash = new Map(assets.map((a) => [a.hash, a]))
	let completion = session.jwt
	let uploaded = 0
	for (const bucket of session.buckets) {
		const files = await Promise.all(
			bucket.map(async (hash) => {
				const asset = byHash.get(hash)
				if (!asset) throw new Error(`Cloudflare asked for an unknown asset ${hash}`)
				return {
					hash,
					base64: (await readFile(asset.file)).toString("base64"),
					contentType: contentType(asset.file),
				}
			})
		)
		completion = (await uploadAssetsBucket(session.jwt, accountId, files)) ?? completion
		uploaded += files.length
	}
	return { jwt: completion, uploaded }
}

// ------------------------------------------------------------------ deploy

export async function deployWorker(
	token: string,
	accountId: string,
	bundle: Bundle,
	cfg: InstanceConfig
): Promise<{ assets: number; uploaded: number }> {
	const assets = await collectAssets(bundle.client)
	const { jwt, uploaded } = await uploadAssets(token, accountId, cfg.name, assets)
	await putWorkerScript(token, accountId, cfg.name, buildWorkerMetadata(bundle, cfg, jwt), [
		{ name: "index.js", content: await readFile(bundle.worker, "utf8") },
	])
	await putCronTriggers(token, accountId, cfg.name, bundle.base.triggers.crons)
	await enableWorkersDev(token, accountId, cfg.name)
	return { assets: assets.length, uploaded }
}
