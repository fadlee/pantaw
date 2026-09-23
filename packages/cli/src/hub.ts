/** Calls against the deployed hub's own API. */

const SESSION_COOKIE = "pantaw_session"

/**
 * Poll /api/health while the fresh workers.dev route and its certificate
 * settle; the first requests after a deploy often fail on their own.
 */
export async function waitForHealth(
	url: string,
	onAttempt: (attempt: number, total: number) => void,
	attempts = 15,
	delayMs = 3000
): Promise<boolean> {
	for (let i = 1; i <= attempts; i++) {
		onAttempt(i, attempts)
		try {
			if ((await fetch(`${url}/api/health`)).ok) return true
		} catch {
			// DNS or certificate not ready yet.
		}
		if (i < attempts) await new Promise((r) => setTimeout(r, delayMs))
	}
	return false
}

export async function needsSetup(url: string): Promise<boolean> {
	const res = await fetch(`${url}/api/v1/auth/setup-status`)
	if (!res.ok) throw new Error(`setup-status answered HTTP ${res.status}`)
	return ((await res.json()) as { needs_setup: boolean }).needs_setup
}

export type SetupResult = { ok: true; cookie: string } | { ok: false; alreadySetup: boolean; error: string }

/** Claim the first admin account. Returns the session cookie on success. */
export async function setupAdmin(url: string, email: string, password: string): Promise<SetupResult> {
	const res = await fetch(`${url}/api/v1/auth/setup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	})
	if (res.status === 409) return { ok: false, alreadySetup: true, error: "already_setup" }
	if (!res.ok) return { ok: false, alreadySetup: false, error: `HTTP ${res.status}: ${await res.text()}` }
	const cookie = sessionCookie(res.headers)
	if (!cookie) return { ok: false, alreadySetup: false, error: "no session cookie in the response" }
	return { ok: true, cookie }
}

export function sessionCookie(headers: Headers): string | undefined {
	for (const c of headers.getSetCookie()) {
		const pair = c.split(";", 1)[0] ?? ""
		if (pair.startsWith(`${SESSION_COOKIE}=`)) return pair
	}
	return undefined
}

/** Register a system and return its first agent token. */
export async function createSystem(url: string, cookie: string, name: string): Promise<string> {
	const res = await fetch(`${url}/api/v1/systems`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ name }),
	})
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
	return ((await res.json()) as { agent_token: string }).agent_token
}

export function agentInstallCommand(url: string, token: string): string {
	return `curl -sSL https://raw.githubusercontent.com/fadlee/pantaw/main/install-agent.sh | sudo bash -s -- -u ${url} -t ${token}`
}
