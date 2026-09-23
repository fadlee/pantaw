import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export interface WranglerAuth {
	token: string
	accountId: string
}

/**
 * Run the wrangler that ships as our own dependency, so no global install is
 * needed. Output is captured and only shown when the command fails.
 */
function run(args: string[], cwd: string, auth: WranglerAuth): Promise<void> {
	const require = createRequire(import.meta.url)
	const bin = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js")
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [bin, ...args], {
			cwd,
			// stdin is not a TTY, so wrangler answers its own confirmation
			// prompts (e.g. "apply N migrations?") with their defaults.
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CLOUDFLARE_API_TOKEN: auth.token,
				CLOUDFLARE_ACCOUNT_ID: auth.accountId,
				WRANGLER_SEND_METRICS: "false",
			},
		})
		let output = ""
		child.stdout.on("data", (d) => {
			output += d
		})
		child.stderr.on("data", (d) => {
			output += d
		})
		child.on("error", reject)
		child.on("close", (code) => {
			if (code === 0) return resolve()
			const tail = output.trim().split("\n").slice(-25).join("\n")
			reject(new Error(`wrangler ${args[0]} exited with ${code}\n${tail}`))
		})
	})
}

/** A throwaway directory holding the generated config for one deploy. */
export async function withWranglerConfig<T>(
	config: unknown,
	auth: WranglerAuth,
	fn: (runWrangler: (args: string[]) => Promise<void>) => Promise<T>
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pantaw-"))
	const configFile = join(dir, "wrangler.json")
	try {
		await writeFile(configFile, JSON.stringify(config, null, "\t"))
		return await fn((args) => run([...args, "--config", configFile], dir, auth))
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}
