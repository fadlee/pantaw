#!/usr/bin/env bun
/**
 * Copy the hub build into packages/cli/bundle so the published package can
 * deploy it: worker script, SPA assets, migrations and the shared parts of
 * the wrangler config. Run `bun run build` at the repo root first.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { extractBase } from "../src/bundle"

const pkg = join(import.meta.dir, "..")
const repo = join(pkg, "..", "..")
const hub = join(repo, "apps", "hub")
const out = join(pkg, "bundle")

const worker = join(hub, "dist", "pantaw", "index.js")
const built = join(hub, "dist", "pantaw", "wrangler.json")
if (!existsSync(worker) || !existsSync(built)) {
	console.error("apps/hub/dist/pantaw not found — run `bun run build` at the repo root first.")
	process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, "worker"), { recursive: true })
cpSync(worker, join(out, "worker", "index.js"))
// Only the shared fields: the built file also holds this checkout's
// database and namespace IDs, which must not ship in a public package.
const base = extractBase(JSON.parse(readFileSync(built, "utf8")))
writeFileSync(join(out, "worker", "base.json"), `${JSON.stringify(base, null, "\t")}\n`)
cpSync(join(hub, "dist", "client"), join(out, "client"), { recursive: true })
cpSync(join(hub, "migrations"), join(out, "migrations"), { recursive: true })
// The bundle ships the hub, so it carries the hub's license and third-party notice.
cpSync(join(repo, "LICENSE"), join(pkg, "LICENSE"))

console.log(`bundle ready: ${out}`)
