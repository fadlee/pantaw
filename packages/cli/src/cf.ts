/** The Cloudflare API calls the CLI makes — all of them; there is no wrangler. */

const API = "https://api.cloudflare.com/client/v4"

export class CfError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly codes: number[]
	) {
		super(message)
	}
}

interface Envelope<T> {
	success: boolean
	result: T
	errors?: { code: number; message: string }[]
	result_info?: { page: number; per_page?: number; total_pages?: number; total_count?: number }
}

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<Envelope<T>> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
	// JSON bodies are strings; FormData sets its own multipart boundary.
	if (typeof init.body === "string") headers["Content-Type"] = "application/json"
	const res = await fetch(`${API}${path}`, { ...init, headers })
	const body = (await res.json().catch(() => null)) as Envelope<T> | null
	if (!res.ok || !body?.success) {
		const errors = body?.errors ?? []
		const detail = errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${res.status}`
		throw new CfError(
			detail,
			res.status,
			errors.map((e) => e.code)
		)
	}
	return body
}

async function all<T>(token: string, path: string): Promise<T[]> {
	const out: T[] = []
	const sep = path.includes("?") ? "&" : "?"
	for (let page = 1; ; page++) {
		const body = await cf<T[]>(token, `${path}${sep}page=${page}&per_page=100`)
		out.push(...body.result)
		// KV reports total_pages; D1 only total_count.
		const info = body.result_info
		const total = info?.total_pages ?? (info?.total_count ? Math.ceil(info.total_count / 100) : 1)
		if (page >= total || body.result.length === 0) return out
	}
}

export interface Account {
	id: string
	name: string
}

export function listAccounts(token: string): Promise<Account[]> {
	return cf<Account[]>(token, "/accounts?per_page=50").then((b) => b.result)
}

/** The account's workers.dev subdomain, or null if it never registered one. */
export async function getWorkersSubdomain(token: string, accountId: string): Promise<string | null> {
	try {
		const body = await cf<{ subdomain: string }>(token, `/accounts/${accountId}/workers/subdomain`)
		return body.result.subdomain || null
	} catch (err) {
		if (err instanceof CfError && err.status === 404) return null
		throw err
	}
}

export interface CfBinding {
	type: string
	name: string
	id?: string
	namespace_id?: string
	text?: string
}

/** Bindings of a deployed Worker, or null when no Worker has that name. */
export async function getWorkerBindings(
	token: string,
	accountId: string,
	name: string
): Promise<CfBinding[] | null> {
	try {
		const body = await cf<{ bindings?: CfBinding[] }>(
			token,
			`/accounts/${accountId}/workers/scripts/${name}/settings`
		)
		return body.result.bindings ?? []
	} catch (err) {
		if (err instanceof CfError && err.status === 404) return null
		throw err
	}
}

export async function listSecretNames(token: string, accountId: string, worker: string): Promise<string[]> {
	const body = await cf<{ name: string }[]>(token, `/accounts/${accountId}/workers/scripts/${worker}/secrets`)
	return body.result.map((s) => s.name)
}

export async function putSecret(
	token: string,
	accountId: string,
	worker: string,
	name: string,
	text: string
): Promise<void> {
	await cf(token, `/accounts/${accountId}/workers/scripts/${worker}/secrets`, {
		method: "PUT",
		body: JSON.stringify({ name, text, type: "secret_text" }),
	})
}

export async function deleteWorker(token: string, accountId: string, name: string): Promise<void> {
	await cf(token, `/accounts/${accountId}/workers/scripts/${name}?force=true`, { method: "DELETE" })
}

/** Run SQL (several statements allowed) against a D1 database. */
export async function d1Query<Row = Record<string, unknown>>(
	token: string,
	accountId: string,
	databaseId: string,
	sql: string
): Promise<{ results: Row[] }[]> {
	const body = await cf<{ results: Row[] }[]>(
		token,
		`/accounts/${accountId}/d1/database/${databaseId}/query`,
		{
			method: "POST",
			body: JSON.stringify({ sql }),
		}
	)
	return body.result
}

export interface D1 {
	uuid: string
	name: string
}

export function listD1(token: string, accountId: string): Promise<D1[]> {
	return all<D1>(token, `/accounts/${accountId}/d1/database`)
}

export async function createD1(token: string, accountId: string, name: string): Promise<D1> {
	const body = await cf<D1>(token, `/accounts/${accountId}/d1/database`, {
		method: "POST",
		body: JSON.stringify({ name }),
	})
	return body.result
}

export async function deleteD1(token: string, accountId: string, id: string): Promise<void> {
	await cf(token, `/accounts/${accountId}/d1/database/${id}`, { method: "DELETE" })
}

export interface KvNamespace {
	id: string
	title: string
}

export function listKv(token: string, accountId: string): Promise<KvNamespace[]> {
	return all<KvNamespace>(token, `/accounts/${accountId}/storage/kv/namespaces`)
}

export async function createKv(token: string, accountId: string, title: string): Promise<KvNamespace> {
	const body = await cf<KvNamespace>(token, `/accounts/${accountId}/storage/kv/namespaces`, {
		method: "POST",
		body: JSON.stringify({ title }),
	})
	return body.result
}

export async function deleteKv(token: string, accountId: string, id: string): Promise<void> {
	await cf(token, `/accounts/${accountId}/storage/kv/namespaces/${id}`, { method: "DELETE" })
}

export interface AssetManifestEntry {
	hash: string
	size: number
}

/**
 * Start an assets upload. Cloudflare answers with the hashes it does not
 * have yet, grouped in buckets; when it already has them all, the returned
 * jwt is the completion token straight away.
 */
export async function startAssetsUpload(
	token: string,
	accountId: string,
	worker: string,
	manifest: Record<string, AssetManifestEntry>
): Promise<{ jwt: string; buckets: string[][] }> {
	const body = await cf<{ jwt: string; buckets?: string[][] }>(
		token,
		`/accounts/${accountId}/workers/scripts/${worker}/assets-upload-session`,
		{ method: "POST", body: JSON.stringify({ manifest }) }
	)
	return { jwt: body.result.jwt, buckets: body.result.buckets ?? [] }
}

/** Upload one bucket of assets. Returns the completion token after the last one. */
export async function uploadAssetsBucket(
	uploadJwt: string,
	accountId: string,
	files: { hash: string; base64: string; contentType: string }[]
): Promise<string | undefined> {
	const form = new FormData()
	for (const f of files) form.append(f.hash, new File([f.base64], f.hash, { type: f.contentType }))
	const body = await cf<{ jwt?: string }>(
		uploadJwt,
		`/accounts/${accountId}/workers/assets/upload?base64=true`,
		{
			method: "POST",
			body: form,
		}
	)
	return body.result?.jwt
}

/** Upload the Worker script with its metadata (bindings, assets, compat settings). */
export async function putWorkerScript(
	token: string,
	accountId: string,
	worker: string,
	metadata: unknown,
	modules: { name: string; content: string }[]
): Promise<void> {
	const form = new FormData()
	form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }))
	for (const m of modules) {
		form.append(m.name, new File([m.content], m.name, { type: "application/javascript+module" }))
	}
	await cf(token, `/accounts/${accountId}/workers/scripts/${worker}`, { method: "PUT", body: form })
}

export async function putCronTriggers(
	token: string,
	accountId: string,
	worker: string,
	crons: string[]
): Promise<void> {
	await cf(token, `/accounts/${accountId}/workers/scripts/${worker}/schedules`, {
		method: "PUT",
		body: JSON.stringify(crons.map((cron) => ({ cron }))),
	})
}

/** Serve the Worker on <worker>.<subdomain>.workers.dev. */
export async function enableWorkersDev(token: string, accountId: string, worker: string): Promise<void> {
	await cf(token, `/accounts/${accountId}/workers/scripts/${worker}/subdomain`, {
		method: "POST",
		body: JSON.stringify({ enabled: true }),
	})
}

/** What an existing Worker is already bound to, for taking it over as-is. */
export interface ExistingBindings {
	d1Id?: string
	kvSession?: string
	kvRate?: string
	ratelimitNamespaceId?: string
	vars: Record<string, string>
}

export function parseBindings(bindings: CfBinding[]): ExistingBindings {
	const out: ExistingBindings = { vars: {} }
	for (const b of bindings) {
		if (b.type === "d1" && b.name === "DB") out.d1Id = b.id
		else if (b.type === "kv_namespace" && b.name === "SESSION_KV") out.kvSession = b.namespace_id
		else if (b.type === "kv_namespace" && b.name === "RATE_KV") out.kvRate = b.namespace_id
		else if (b.type === "ratelimit" && b.name === "INGEST_LIMITER") out.ratelimitNamespaceId = b.namespace_id
		else if (b.type === "plain_text" && b.text !== undefined) out.vars[b.name] = b.text
	}
	return out
}

/**
 * API token page with the permissions pre-selected, so creating the token is
 * one click. Workers Scripts also covers the workers.dev subdomain and secrets.
 */
export function tokenCreateUrl(): string {
	const permissions = [
		{ key: "workers_scripts", type: "edit" },
		{ key: "d1", type: "edit" },
		{ key: "workers_kv_storage", type: "edit" },
	]
	const params = new URLSearchParams({
		permissionGroupKeys: JSON.stringify(permissions),
		accountId: "*",
		zoneId: "all",
		name: "pantaw-cli",
	})
	return `https://dash.cloudflare.com/profile/api-tokens?${params}`
}
