import { api, setCurrentUser } from "@/lib/api"
import type { AuthUser } from "@/lib/api"
/**
 * Login page untuk Pantaw.
 * Menggantikan Beszel login yang pakai PocketBase auth (OAuth, OTP, dll).
 * Pantaw pakai email/password + cookie HttpOnly.
 */
import { t } from "@lingui/core/macro"
import { useLingui } from "@lingui/react/macro"
import { useState } from "react"

export default function LoginPage() {
	const { t: _ } = useLingui()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

	// Check setup status on mount
	useState(() => {
		api.auth["setup-status"].$get().then(async (res) => {
			if (res.ok) {
				const data = (await res.json()) as { needs_setup: boolean }
				setNeedsSetup(data.needs_setup)
			}
		})
	})

	async function handleLogin(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setLoading(true)
		try {
			const res = await api.auth.login.$post({ json: { email, password } })
			const status = res.status
			if (!res.ok) {
				if (status === 401) setError(t`Invalid email or password`)
				else if (status === 429) setError(t`Too many attempts. Try again later.`)
				else setError(t`Login failed`)
				return
			}
			const user = (await res.json()) as AuthUser
			setCurrentUser(user)
		} catch {
			setError(t`Network error`)
		} finally {
			setLoading(false)
		}
	}

	async function handleSetup(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setLoading(true)
		try {
			const res = await api.auth.setup.$post({ json: { email, password } })
			const status = res.status
			if (!res.ok) {
				if (status === 409) setError(t`Setup already completed`)
				else setError(t`Setup failed`)
				return
			}
			const user = (await res.json()) as AuthUser
			setCurrentUser(user)
		} catch {
			setError(t`Network error`)
		} finally {
			setLoading(false)
		}
	}

	const isSetup = needsSetup === true

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4">
			<div className="w-full max-w-sm space-y-6">
				<div className="space-y-1 text-center">
					<h1 className="text-2xl font-semibold tracking-tight">{isSetup ? t`Setup Pantaw` : "Pantaw"}</h1>
					<p className="text-sm text-muted-foreground">
						{isSetup ? t`Create the first admin account to get started` : t`Sign in to your account`}
					</p>
				</div>
				<form onSubmit={isSetup ? handleSetup : handleLogin} className="space-y-4">
					<div className="space-y-2">
						<label htmlFor="email" className="text-sm font-medium">
							{t`Email`}
						</label>
						<input
							id="email"
							type="email"
							autoComplete="email"
							required
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							disabled={loading}
							className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						/>
					</div>
					<div className="space-y-2">
						<label htmlFor="password" className="text-sm font-medium">
							{t`Password`}
						</label>
						<input
							id="password"
							type="password"
							autoComplete={isSetup ? "new-password" : "current-password"}
							required
							minLength={isSetup ? 8 : 1}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							disabled={loading}
							className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						/>
					</div>
					{error && (
						<p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive text-sm">
							{error}
						</p>
					)}
					<button
						type="submit"
						disabled={loading}
						className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
					>
						{loading ? t`Processing…` : isSetup ? t`Create admin account` : t`Sign in`}
					</button>
				</form>
			</div>
		</div>
	)
}
