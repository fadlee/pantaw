import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Button, Card, FormField, Input } from "../components/ui"
import { api } from "../lib/api"

export function LoginForm() {
	const qc = useQueryClient()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState<string | null>(null)

	const mutation = useMutation({
		mutationFn: async (input: { email: string; password: string }) => {
			const res = await api.api.v1.auth.login.$post({ json: input })
			const status = res.status
			if (!res.ok) {
				if (status === 401) throw new Error("Email atau password salah.")
				if (status === 429) throw new Error("Terlalu banyak percobaan. Coba lagi nanti.")
				throw new Error(`Login gagal (${status}).`)
			}
			return res.json()
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["me"] })
		},
		onError: (e: Error) => setError(e.message),
	})

	function submit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		mutation.mutate({ email, password })
	}

	return (
		<div className="flex min-h-full items-center justify-center px-4 py-10">
			<Card>
				<div className="mb-6 space-y-1">
					<h1 className="font-semibold text-xl text-zinc-100">Masuk Pantaw</h1>
					<p className="text-sm text-zinc-400">Gunakan akun admin yang sudah dibuat.</p>
				</div>
				<form onSubmit={submit} className="flex flex-col gap-4">
					<FormField label="Email">
						{({ id }) => (
							<Input
								id={id}
								type="email"
								autoComplete="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								disabled={mutation.isPending}
							/>
						)}
					</FormField>
					<FormField label="Password">
						{({ id }) => (
							<Input
								id={id}
								type="password"
								autoComplete="current-password"
								required
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								disabled={mutation.isPending}
							/>
						)}
					</FormField>
					{error && (
						<p className="rounded-md border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-rose-300 text-sm">
							{error}
						</p>
					)}
					<Button type="submit" disabled={mutation.isPending}>
						{mutation.isPending ? "Memproses…" : "Masuk"}
					</Button>
				</form>
			</Card>
		</div>
	)
}
