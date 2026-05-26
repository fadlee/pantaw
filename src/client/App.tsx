import { useQuery } from "@tanstack/react-query"
import { api } from "./lib/api"

type SetupStatus = { needs_setup: boolean }
type Me = { id: string; email: string; role: "admin" | "user" }

function useSetupStatus() {
	return useQuery({
		queryKey: ["setup-status"],
		queryFn: async (): Promise<SetupStatus> => {
			const res = await api.api.v1.auth["setup-status"].$get()
			if (!res.ok) throw new Error("failed to fetch setup status")
			return (await res.json()) as SetupStatus
		},
	})
}

function useMe() {
	return useQuery({
		queryKey: ["me"],
		queryFn: async (): Promise<Me | null> => {
			const res = await api.api.v1.auth.me.$get()
			if (res.status === 401) return null
			if (!res.ok) throw new Error("failed to fetch me")
			return (await res.json()) as Me
		},
	})
}

export default function App() {
	const setup = useSetupStatus()
	const me = useMe()

	if (setup.isLoading || me.isLoading) {
		return (
			<div className="flex h-full items-center justify-center text-zinc-400">
				<p>Loading…</p>
			</div>
		)
	}

	if (setup.data?.needs_setup) {
		return <SetupForm />
	}

	if (!me.data) {
		return <LoginForm />
	}

	return <Dashboard user={me.data} />
}

function SetupForm() {
	return (
		<Center>
			<h1 className="font-semibold text-2xl">Welcome to Pantaw</h1>
			<p className="text-sm text-zinc-400">First-time setup form akan dipasang berikutnya.</p>
		</Center>
	)
}

function LoginForm() {
	return (
		<Center>
			<h1 className="font-semibold text-2xl">Pantaw</h1>
			<p className="text-sm text-zinc-400">Login form akan dipasang berikutnya.</p>
		</Center>
	)
}

function Dashboard({ user }: { user: Me }) {
	return (
		<Center>
			<h1 className="font-semibold text-2xl">Dashboard</h1>
			<p className="text-sm text-zinc-400">
				Halo, <span className="font-mono">{user.email}</span> ({user.role})
			</p>
		</Center>
	)
}

function Center({ children }: { children: React.ReactNode }) {
	return <div className="flex h-full flex-col items-center justify-center gap-2">{children}</div>
}
