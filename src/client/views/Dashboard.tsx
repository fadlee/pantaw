import { useMutation, useQueryClient } from "@tanstack/react-query"
import { LogOut } from "lucide-react"
import { Button } from "../components/ui"
import { api } from "../lib/api"

type Me = { id: string; email: string; role: "admin" | "user" }

export function Dashboard({ user }: { user: Me }) {
	const qc = useQueryClient()
	const logout = useMutation({
		mutationFn: async () => {
			await api.api.v1.auth.logout.$post()
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["me"] })
		},
	})

	return (
		<div className="flex min-h-full flex-col">
			<header className="flex items-center justify-between border-zinc-800 border-b bg-zinc-950/80 px-6 py-4 backdrop-blur">
				<div className="flex items-center gap-3">
					<div className="font-semibold text-lg text-zinc-100">Pantaw</div>
					<span className="rounded-md border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{user.role}</span>
				</div>
				<div className="flex items-center gap-4">
					<span className="font-mono text-sm text-zinc-400">{user.email}</span>
					<Button variant="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
						<LogOut className="mr-2 h-4 w-4" />
						Logout
					</Button>
				</div>
			</header>
			<main className="flex flex-1 items-center justify-center p-8">
				<div className="text-center">
					<h2 className="font-semibold text-xl text-zinc-100">Dashboard placeholder</h2>
					<p className="mt-2 text-sm text-zinc-500">
						Daftar system, metrik time-series, dan alert UI akan dipasang berikutnya.
					</p>
				</div>
			</main>
		</div>
	)
}
