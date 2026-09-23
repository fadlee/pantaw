#!/usr/bin/env node
/**
 * pantaw — deploy and upgrade a Pantaw hub on your own Cloudflare account.
 *
 *   deploy   First run: wizard from API token to first server. Later runs:
 *            migrate and redeploy the version this CLI ships.
 *   status   Show an instance and probe its health
 *   list     List instances configured on this machine
 *   destroy  Delete the Worker, D1 database and KV namespaces
 */
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { parseArgs } from "node:util"
import * as p from "@clack/prompts"
import pc from "picocolors"
import pkg from "../package.json" with { type: "json" }
import { type Bundle, buildWranglerConfig, locateBundle } from "./bundle"
import {
	type Account,
	CfError,
	type ExistingBindings,
	createD1,
	createKv,
	deleteD1,
	deleteKv,
	deleteWorker,
	getWorkerBindings,
	getWorkersSubdomain,
	listAccounts,
	listD1,
	listKv,
	listSecretNames,
	parseBindings,
	putSecret,
	tokenCreateUrl,
} from "./cf"
import {
	type InstanceConfig,
	configDir,
	configPath,
	listConfigs,
	loadConfig,
	ratelimitNamespaceId,
	removeConfig,
	resourceNames,
	saveConfig,
	validateName,
} from "./config"
import { agentInstallCommand, createSystem, needsSetup, setupAdmin, waitForHealth } from "./hub"
import { withWranglerConfig } from "./wrangler"

const VERSION = pkg.version
const HELP = `${pc.bold("pantaw")} v${VERSION} — deploy a Pantaw hub to Cloudflare

Usage
  bunx pantaw deploy [--name <instance>] [--yes]
  bunx pantaw status [--name <instance>]
  bunx pantaw list
  bunx pantaw destroy [--name <instance>]

Options
  -n, --name <name>  Instance name, also the Worker name (default: pantaw)
  -y, --yes          Never prompt; fail when an answer is missing
  -h, --help         Show this help
  -v, --version      Show the version

Environment
  CLOUDFLARE_API_TOKEN              Used instead of prompting or the saved token
  CLOUDFLARE_ACCOUNT_ID             Picks the account when the token sees several
  PANTAW_ADMIN_EMAIL/_PASSWORD      First admin account for non-interactive deploys
  XDG_CONFIG_HOME                   Config lives in $XDG_CONFIG_HOME/pantaw (~/.config/pantaw)
`

class Bail extends Error {}

/** Stop with a message; caught once in main(). */
function bail(message: string): never {
	throw new Bail(message)
}

function ask<T>(value: T | symbol): Exclude<T, symbol> {
	if (p.isCancel(value)) {
		p.cancel("Cancelled.")
		process.exit(0)
	}
	return value as Exclude<T, symbol>
}

async function step<T>(label: string, fn: () => Promise<T>, done: (r: T) => string): Promise<T> {
	const s = p.spinner()
	s.start(label)
	try {
		const result = await fn()
		s.stop(done(result))
		return result
	} catch (err) {
		s.error(`${label} — failed`)
		throw err
	}
}

/**
 * Print text meant to be copied — long URLs, shell commands — on its own line
 * with no box or gutter. Inside a clack note the terminal wraps it into
 * several bordered lines, and copying picks up the border characters.
 */
function printCopyable(text: string): void {
	process.stdout.write(`\n${pc.cyan(text)}\n\n`)
}

function openUrl(url: string): void {
	const opener =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
	execFile(opener, [url], () => {
		// No browser (e.g. over SSH): the link is printed anyway.
	})
}

// ------------------------------------------------------------------ shared steps

interface Ctx {
	interactive: boolean
	dir: string
}

async function resolveToken(
	ctx: Ctx,
	cfg: InstanceConfig | null
): Promise<{ token: string; prompted: boolean }> {
	const env = process.env.CLOUDFLARE_API_TOKEN?.trim()
	if (env) {
		p.log.info("Using the token from CLOUDFLARE_API_TOKEN.")
		return { token: env, prompted: false }
	}
	if (cfg?.api_token) {
		p.log.info(`Using the token saved in ${configPath(ctx.dir, cfg.name)}.`)
		return { token: cfg.api_token, prompted: false }
	}
	if (!ctx.interactive) bail("No Cloudflare API token. Set CLOUDFLARE_API_TOKEN.")

	const url = tokenCreateUrl()
	p.note(
		[
			"Pantaw needs an API token with these permissions:",
			"  Account → Workers Scripts    → Edit",
			"  Account → D1                 → Edit",
			"  Account → Workers KV Storage → Edit",
			"",
			"The link below opens the token page with them pre-selected.",
		].join("\n"),
		"Cloudflare API token"
	)
	printCopyable(url)
	if (ask(await p.confirm({ message: "Open that page in your browser?", initialValue: true }))) openUrl(url)
	const token = ask(
		await p.password({
			message: "Paste the API token",
			validate: (v) => (v && v.trim().length >= 20 ? undefined : "That does not look like a token"),
		})
	)
	return { token: token.trim(), prompted: true }
}

async function resolveAccount(ctx: Ctx, token: string, cfg: InstanceConfig | null): Promise<Account> {
	let accounts: Account[]
	try {
		accounts = await step(
			"Checking the token",
			() => listAccounts(token),
			(a) => `Token valid · ${a.length} account(s)`
		)
	} catch (err) {
		if (err instanceof CfError && (err.status === 400 || err.status === 401 || err.status === 403)) {
			bail(`Cloudflare rejected the token: ${err.message}`)
		}
		throw err
	}

	if (cfg) {
		const account = accounts.find((a) => a.id === cfg.account_id)
		if (!account) {
			bail(
				`Instance "${cfg.name}" lives in account ${cfg.account_name ?? cfg.account_id}, which this token cannot access. Use a token for that account.`
			)
		}
		return account
	}
	if (accounts.length === 0) bail("This token cannot see any account.")
	if (accounts.length === 1) return accounts[0] as Account

	const fromEnv = accounts.find((a) => a.id === process.env.CLOUDFLARE_ACCOUNT_ID)
	if (fromEnv) return fromEnv
	if (!ctx.interactive) bail("The token can see several accounts. Set CLOUDFLARE_ACCOUNT_ID to pick one.")
	const id = ask(
		await p.select({
			message: "Which Cloudflare account?",
			options: accounts.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
		})
	)
	return accounts.find((a) => a.id === id) as Account
}

/** An instance that already has a config file, for status and destroy. */
async function pickConfigured(ctx: Ctx, name: string | undefined): Promise<InstanceConfig> {
	if (name) {
		const cfg = await loadConfig(ctx.dir, name)
		if (!cfg) bail(`No instance "${name}" in ${ctx.dir}. See \`pantaw list\`.`)
		return cfg
	}
	const configs = await listConfigs(ctx.dir)
	if (configs.length === 0) bail("No instances configured yet. Run `pantaw deploy` first.")
	if (configs.length === 1) return configs[0] as InstanceConfig
	if (!ctx.interactive) bail("Several instances are configured. Pass --name.")
	const chosen = ask(
		await p.select({
			message: "Which instance?",
			options: configs.map((c) => ({ value: c.name, label: c.name, hint: c.url })),
		})
	)
	return configs.find((c) => c.name === chosen) as InstanceConfig
}

// ------------------------------------------------------------------ deploy

const NEW_INSTANCE = "\0new"

async function pickDeployTarget(
	ctx: Ctx,
	flagName: string | undefined
): Promise<{ name: string; cfg: InstanceConfig | null }> {
	if (flagName) {
		const invalid = validateName(flagName)
		if (invalid) bail(`Invalid --name: ${invalid}`)
		return { name: flagName, cfg: await loadConfig(ctx.dir, flagName) }
	}
	const configs = await listConfigs(ctx.dir)
	if (!ctx.interactive) {
		if (configs.length === 1)
			return { name: (configs[0] as InstanceConfig).name, cfg: configs[0] as InstanceConfig }
		if (configs.length > 1) bail("Several instances are configured. Pass --name.")
		return { name: "pantaw", cfg: null }
	}
	if (configs.length > 0) {
		const chosen = ask(
			await p.select({
				message: "Which instance?",
				options: [
					...configs.map((c) => ({ value: c.name, label: `Upgrade ${c.name}`, hint: c.url })),
					{ value: NEW_INSTANCE, label: "New instance" },
				],
			})
		)
		const cfg = configs.find((c) => c.name === chosen)
		if (cfg) return { name: cfg.name, cfg }
	}
	const taken = new Set(configs.map((c) => c.name))
	const name = ask(
		await p.text({
			message: "Instance name (also the Worker name)",
			initialValue: taken.has("pantaw") ? "" : "pantaw",
			validate: (v) =>
				validateName(v ?? "") ?? (taken.has(v ?? "") ? "Already configured — pick it from the list" : undefined),
		})
	)
	return { name, cfg: null }
}

interface AdminCreds {
	email: string
	password: string
}

async function askAdmin(): Promise<AdminCreds> {
	p.log.step("First admin account — created as soon as the hub is up, so nobody else can claim it.")
	const email = ask(
		await p.text({
			message: "Admin email",
			validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v ?? "") ? undefined : "Invalid email"),
		})
	)
	const password = ask(
		await p.password({
			message: "Admin password (min 8 characters)",
			validate: (v) => ((v ?? "").length >= 8 ? undefined : "At least 8 characters"),
		})
	)
	ask(
		await p.password({
			message: "Repeat the password",
			validate: (v) => (v === password ? undefined : "Passwords do not match"),
		})
	)
	return { email: email.trim(), password }
}

function adminFromEnv(): AdminCreds | null {
	const email = process.env.PANTAW_ADMIN_EMAIL
	const password = process.env.PANTAW_ADMIN_PASSWORD
	return email && password ? { email, password } : null
}

/**
 * Find or create the D1 database and KV namespaces. When taking over a Worker
 * its current bindings win over the derived names, so data carries over.
 */
async function provision(
	token: string,
	account: Account,
	name: string,
	url: string,
	bundle: Bundle,
	existing: ExistingBindings | null
): Promise<InstanceConfig> {
	const names = resourceNames(name)
	return step(
		"Provisioning D1 and KV",
		async () => {
			const d1s = await listD1(token, account.id)
			let d1 = existing?.d1Id ? d1s.find((d) => d.uuid === existing.d1Id) : d1s.find((d) => d.name === names.d1)
			if (!d1 && existing?.d1Id) bail(`The Worker is bound to D1 ${existing.d1Id}, which no longer exists.`)
			d1 ??= await createD1(token, account.id, names.d1)

			const kvs = await listKv(token, account.id)
			const ensureKv = async (title: string) =>
				(kvs.find((k) => k.title === title) ?? (await createKv(token, account.id, title))).id

			const now = new Date().toISOString()
			const cfg: InstanceConfig = {
				name,
				account_id: account.id,
				account_name: account.name,
				url,
				d1: { id: d1.uuid, name: d1.name },
				kv: {
					session: existing?.kvSession ?? (await ensureKv(names.kvSession)),
					rate: existing?.kvRate ?? (await ensureKv(names.kvRate)),
				},
				ratelimit_namespace_id: existing?.ratelimitNamespaceId ?? ratelimitNamespaceId(name),
				vars: { ...bundle.base.vars, ...existing?.vars },
				version: VERSION,
				created_at: now,
				updated_at: now,
			}
			return cfg
		},
		(cfg) => `D1 ${cfg.d1.name} · KV ${names.kvSession}, ${names.kvRate}`
	)
}

/**
 * Generate the JWT signing secret on first deploy. Once JWT_KID_CURRENT
 * exists the secrets are left alone: replacing them would sign every user out
 * and undo a key rotation done by hand.
 */
async function ensureSecrets(token: string, accountId: string, worker: string): Promise<string[]> {
	const existing = await listSecretNames(token, accountId, worker)
	if (existing.includes("JWT_KID_CURRENT")) return []
	const added: string[] = []
	if (!existing.includes("JWT_SECRET_V1")) {
		await putSecret(token, accountId, worker, "JWT_SECRET_V1", randomBytes(48).toString("base64url"))
		added.push("JWT_SECRET_V1")
	}
	await putSecret(token, accountId, worker, "JWT_KID_CURRENT", "v1")
	added.push("JWT_KID_CURRENT")
	return added
}

async function cmdDeploy(ctx: Ctx, flagName: string | undefined) {
	p.intro(`${pc.bgCyan(pc.black(" pantaw deploy "))} ${pc.dim(`v${VERSION}`)}`)

	let bundle: Bundle
	try {
		bundle = locateBundle()
	} catch (err) {
		bail((err as Error).message)
	}

	const target = await pickDeployTarget(ctx, flagName)
	const { name } = target
	const { token, prompted } = await resolveToken(ctx, target.cfg)
	const account = await resolveAccount(ctx, token, target.cfg)

	const subdomain = await getWorkersSubdomain(token, account.id)
	if (!subdomain) {
		bail(
			"This account has no workers.dev subdomain yet. Open Workers & Pages in the " +
				"Cloudflare dashboard once to choose one, then run this again."
		)
	}
	const url = `https://${name}.${subdomain}.workers.dev`

	let cfg: InstanceConfig
	let mode: "fresh" | "takeover" | "upgrade"
	let admin: AdminCreds | null = null
	if (target.cfg) {
		mode = "upgrade"
		cfg = { ...target.cfg, url, version: VERSION, updated_at: new Date().toISOString() }
		p.log.info(`Upgrading ${pc.bold(name)} to v${VERSION}. Data in D1 and KV is kept.`)
	} else {
		const bindings = await getWorkerBindings(token, account.id, name)
		let existing: ExistingBindings | null = null
		if (bindings) {
			if (!ctx.interactive) {
				bail(
					`A Worker named "${name}" already exists but is not configured here. Re-run without --yes to take it over.`
				)
			}
			existing = parseBindings(bindings)
			p.note(
				[
					`Account ${account.name} already runs a Worker named "${name}",`,
					`but ${configPath(ctx.dir, name)} does not exist.`,
					"",
					"Taking over redeploys it with this version and keeps using the D1",
					"database and KV namespaces it is bound to right now. Secrets stay.",
				].join("\n"),
				"Existing Worker"
			)
			const ok = ask(await p.confirm({ message: `Take over "${name}"?`, initialValue: false }))
			if (!ok) bail("Left alone — nothing was changed.")
			mode = "takeover"
		} else {
			mode = "fresh"
			admin = ctx.interactive ? await askAdmin() : adminFromEnv()
		}
		cfg = await provision(token, account, name, url, bundle, existing)
	}

	const auth = { token, accountId: account.id }
	await withWranglerConfig(buildWranglerConfig(bundle, cfg), auth, async (wrangler) => {
		await step(
			"Applying database migrations",
			() => wrangler(["d1", "migrations", "apply", "DB", "--remote"]),
			() => "Migrations up to date"
		)
		await step(
			"Deploying the Worker",
			() => wrangler(["deploy"]),
			() => `Deployed ${cfg.url}`
		)
	})
	await step(
		"Checking secrets",
		() => ensureSecrets(token, account.id, name),
		(added) => (added.length > 0 ? `Secrets set: ${added.join(", ")}` : "Secrets already set")
	)
	// Saved before anything that can still fail, so a re-run upgrades in place.
	const savedPath = await saveConfig(ctx.dir, cfg)

	const s = p.spinner()
	s.start("Waiting for the hub to answer")
	const healthy = await waitForHealth(cfg.url, (i, n) =>
		s.message(`Waiting for the hub to answer (${i}/${n})`)
	)
	if (healthy) s.stop("Hub is up")
	else s.error("Hub is not answering yet")

	let cookie: string | undefined
	if (!healthy) {
		p.log.warn("Run `pantaw deploy` again in a minute to finish the admin setup.")
	} else if (await needsSetup(cfg.url)) {
		admin ??= ctx.interactive ? await askAdmin() : adminFromEnv()
		if (!admin) {
			p.log.warn(
				`No admin account yet. Open ${cfg.url} and create it now — until then anyone who finds the URL can claim it.`
			)
		} else {
			const result = await setupAdmin(cfg.url, admin.email, admin.password)
			if (result.ok) {
				cookie = result.cookie
				p.log.success(`Admin account created: ${admin.email}`)
			} else if (result.alreadySetup) {
				p.log.error(
					pc.red(
						`Someone else created the admin account first. Do not use this instance: run \`pantaw destroy --name ${name}\` and deploy again.`
					)
				)
			} else {
				p.log.warn(`Admin setup failed (${result.error}). Create it from the dashboard.`)
			}
		}
	}

	if (cookie && ctx.interactive) {
		const add = ask(await p.confirm({ message: "Add your first server now?", initialValue: true }))
		if (add) {
			const serverName = ask(
				await p.text({
					message: "Server name",
					placeholder: "web-1",
					validate: (v) => (v?.trim() ? undefined : "Required"),
				})
			)
			try {
				const agentToken = await createSystem(cfg.url, cookie, serverName.trim())
				p.log.step(`Run this on ${serverName.trim()}:`)
				printCopyable(agentInstallCommand(cfg.url, agentToken))
				p.log.info(pc.dim("The token is shown once; the dashboard can issue new ones."))
			} catch (err) {
				p.log.warn(`Could not add the server (${(err as Error).message}). Add it from the dashboard.`)
			}
		}
	}

	if (prompted && ctx.interactive) {
		const save = ask(
			await p.confirm({
				message: "Save the API token so later deploys don't ask again?",
				initialValue: false,
			})
		)
		if (save) {
			cfg.api_token = token
			await saveConfig(ctx.dir, cfg)
		}
	}

	p.note(
		[
			`${pc.dim("dashboard")}  ${pc.cyan(cfg.url)}`,
			`${pc.dim("instance ")}  ${name} (${mode})`,
			`${pc.dim("config   ")}  ${savedPath}${cfg.api_token ? " · token saved" : ""}`,
		].join("\n"),
		"Pantaw is live"
	)
	p.outro(`Upgrade later with ${pc.cyan(`bunx pantaw@latest deploy --name ${name}`)}`)
}

// ------------------------------------------------------------------ status, list

async function cmdStatus(ctx: Ctx, flagName: string | undefined) {
	p.intro(`${pc.bgCyan(pc.black(" pantaw status "))}`)
	const cfg = await pickConfigured(ctx, flagName)
	p.note(
		[
			`${pc.dim("dashboard")}  ${cfg.url}`,
			`${pc.dim("account  ")}  ${cfg.account_name ?? ""} ${pc.dim(cfg.account_id)}`,
			`${pc.dim("d1       ")}  ${cfg.d1.name} ${pc.dim(cfg.d1.id)}`,
			`${pc.dim("kv       ")}  ${pc.dim(`${cfg.kv.session}, ${cfg.kv.rate}`)}`,
			`${pc.dim("version  ")}  v${cfg.version} · deployed ${new Date(cfg.updated_at).toLocaleString()}`,
			`${pc.dim("token    ")}  ${cfg.api_token ? "saved" : "not saved"}`,
		].join("\n"),
		cfg.name
	)
	try {
		await step(
			"Probing /api/health",
			async () => {
				const res = await fetch(`${cfg.url}/api/health`)
				if (!res.ok) throw new Error(`HTTP ${res.status}`)
			},
			() => "Hub is healthy"
		)
	} catch (err) {
		p.log.warn((err as Error).message)
	}
	p.outro("")
}

async function cmdList(ctx: Ctx) {
	const configs = await listConfigs(ctx.dir)
	if (configs.length === 0) {
		console.log(`No instances in ${ctx.dir}. Run \`bunx pantaw deploy\`.`)
		return
	}
	for (const c of configs) {
		console.log(`${pc.bold(c.name.padEnd(20))} ${c.url.padEnd(45)} ${pc.dim(`v${c.version}`)}`)
	}
}

// ------------------------------------------------------------------ destroy

async function cmdDestroy(ctx: Ctx, flagName: string | undefined) {
	p.intro(`${pc.bgRed(pc.white(" pantaw destroy "))}`)
	if (!ctx.interactive && !flagName) bail("Non-interactive destroy needs an explicit --name.")
	const cfg = await pickConfigured(ctx, flagName)
	p.note(
		[
			`Worker   ${cfg.name} (${cfg.url})`,
			`D1       ${cfg.d1.name} — every metric, system, user and alert`,
			`KV       ${cfg.kv.session}, ${cfg.kv.rate}`,
			"",
			"This cannot be undone. Export the database first if you need it:",
		].join("\n"),
		pc.red("About to delete")
	)
	printCopyable(`bunx wrangler d1 export ${cfg.d1.name} --remote --output backup.sql`)
	if (ctx.interactive) {
		ask(
			await p.text({
				message: `Type ${pc.bold(cfg.name)} to confirm`,
				validate: (v) => (v === cfg.name ? undefined : "Does not match"),
			})
		)
		const sure = ask(await p.confirm({ message: "Delete everything listed above?", initialValue: false }))
		if (!sure) bail("Nothing was deleted.")
	}

	const { token } = await resolveToken(ctx, cfg)
	const account = await resolveAccount(ctx, token, cfg)
	const gone = (err: unknown) => {
		// Already deleted by hand is fine; anything else is not.
		if (!(err instanceof CfError && err.status === 404)) throw err
	}
	await step(
		"Deleting the Worker",
		() => deleteWorker(token, account.id, cfg.name).catch(gone),
		() => "Worker deleted"
	)
	await step(
		"Deleting D1",
		() => deleteD1(token, account.id, cfg.d1.id).catch(gone),
		() => "D1 deleted"
	)
	await step(
		"Deleting KV",
		async () => {
			await deleteKv(token, account.id, cfg.kv.session).catch(gone)
			await deleteKv(token, account.id, cfg.kv.rate).catch(gone)
		},
		() => "KV deleted"
	)
	await removeConfig(ctx.dir, cfg.name)
	p.outro(`${cfg.name} is gone.`)
}

// ------------------------------------------------------------------ main

async function main() {
	let parsed: ReturnType<typeof parse>
	try {
		parsed = parse()
	} catch (err) {
		console.error(`${(err as Error).message}\n\n${HELP}`)
		process.exit(1)
	}
	const { values, positionals } = parsed
	if (values.version) return console.log(VERSION)
	const command = positionals[0]
	if (values.help || !command) return console.log(HELP)

	const ctx: Ctx = { interactive: !values.yes && Boolean(process.stdin.isTTY), dir: configDir() }
	try {
		if (command === "deploy") await cmdDeploy(ctx, values.name)
		else if (command === "status") await cmdStatus(ctx, values.name)
		else if (command === "list") await cmdList(ctx)
		else if (command === "destroy") await cmdDestroy(ctx, values.name)
		else {
			console.error(`Unknown command: ${command}\n\n${HELP}`)
			process.exit(1)
		}
	} catch (err) {
		p.cancel(err instanceof Bail ? err.message : `Failed: ${(err as Error).message}`)
		process.exit(1)
	}
}

function parse() {
	return parseArgs({
		allowPositionals: true,
		options: {
			name: { type: "string", short: "n" },
			yes: { type: "boolean", short: "y" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	})
}

main()
