import { useQuery } from "@tanstack/react-query"
import { api } from "./lib/api"
import { Dashboard } from "./views/Dashboard"
import { LoginForm } from "./views/LoginForm"
import { SetupForm } from "./views/SetupForm"

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
