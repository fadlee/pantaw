/**
 * Systems settings page — tampilkan daftar systems + token management.
 * Menggantikan Tokens & Fingerprints dari Beszel yang tidak relevan di Pantaw.
 */
import { t } from "@lingui/core/macro"
import { Trans, useLingui } from "@lingui/react/macro"
import { CopyIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { useEffect, useState } from "react"
import { AddSystemDialog } from "@/components/add-system"
import { Button } from "@/components/ui/button"
import { apiClient } from "@/lib/api"
import * as systemsManager from "@/lib/systemsManager"
import { $allSystemsById } from "@/lib/stores"

type System = {
	id: string
	name: string
	host: string
	status: string
	last_seen: number | null
}

type Token = {
	id: string
	agent_token: string
	created_at: number
}

export default function SystemsSettings() {
	const { t: _ } = useLingui()
	const [systems, setSystems] = useState<System[]>([])
	const [loading, setLoading] = useState(true)
	const [addOpen, setAddOpen] = useState(false)
	const [rotatingId, setRotatingId] = useState<string | null>(null)
	const [newToken, setNewToken] = useState<{ systemName: string; token: string } | null>(null)
	const [deletingId, setDeletingId] = useState<string | null>(null)

	async function fetchSystems() {
		setLoading(true)
		try {
			const res = await apiClient.api.v1.systems.$get()
			if (res.ok) setSystems((await res.json()) as System[])
		} finally {
			setLoading(false)
		}
	}

	useEffect(() => {
		fetchSystems()
	}, [])

	async function rotateToken(system: System) {
		setRotatingId(system.id)
		try {
			const res = await apiClient.api.v1.systems[":id"].tokens.$post({ param: { id: system.id } })
			if (res.ok) {
				const data = (await res.json()) as Token
				setNewToken({ systemName: system.name, token: data.agent_token })
			}
		} finally {
			setRotatingId(null)
		}
	}

	async function deleteSystem(system: System) {
		if (!confirm(t`Are you sure you want to delete ${system.name}?`)) return
		setDeletingId(system.id)
		try {
			const res = await apiClient.api.v1.systems[":id"].$delete({ param: { id: system.id } })
			if (res.ok) {
				const sys = $allSystemsById.get()[system.id]
				if (sys) systemsManager.remove(sys)
				setSystems((prev) => prev.filter((s) => s.id !== system.id))
			}
		} finally {
			setDeletingId(null)
		}
	}

	function copyToken(token: string) {
		navigator.clipboard.writeText(token)
	}

	return (
		<div className="space-y-6">
			<div>
				<h3 className="text-lg font-medium"><Trans>Systems</Trans></h3>
				<p className="text-sm text-muted-foreground">
					<Trans>Manage monitored systems and their agent tokens.</Trans>
				</p>
			</div>

			<div className="flex justify-between items-center">
				<Button variant="outline" size="sm" onClick={fetchSystems} disabled={loading}>
					<RefreshCwIcon className="h-4 w-4 mr-2" />
					<Trans>Refresh</Trans>
				</Button>
				<Button size="sm" onClick={() => setAddOpen(true)}>
					<PlusIcon className="h-4 w-4 mr-2" />
					<Trans>Add System</Trans>
				</Button>
			</div>

			{loading ? (
				<p className="text-sm text-muted-foreground"><Trans>Loading…</Trans></p>
			) : systems.length === 0 ? (
				<p className="text-sm text-muted-foreground"><Trans>No systems yet.</Trans></p>
			) : (
				<div className="space-y-2">
					{systems.map((sys) => (
						<div
							key={sys.id}
							className="flex items-center justify-between rounded-lg border p-3 gap-4"
						>
							<div className="min-w-0">
								<p className="font-medium truncate">{sys.name}</p>
								<p className="text-xs text-muted-foreground font-mono truncate">{sys.host}</p>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								<Button
									variant="outline"
									size="sm"
									onClick={() => rotateToken(sys)}
									disabled={rotatingId === sys.id}
									title={t`Generate new token`}
								>
									<RefreshCwIcon className="h-3.5 w-3.5 mr-1.5" />
									<Trans>New token</Trans>
								</Button>
								<Button
									variant="ghost"
									size="icon"
									className="text-destructive hover:text-destructive"
									onClick={() => deleteSystem(sys)}
									disabled={deletingId === sys.id}
									title={t`Delete system`}
								>
									<Trash2Icon className="h-4 w-4" />
								</Button>
							</div>
						</div>
					))}
				</div>
			)}

			{/* New token reveal */}
			{newToken && (
				<div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 space-y-2">
					<p className="text-sm font-medium">
						<Trans>New token for {newToken.systemName} — copy now, it won't be shown again.</Trans>
					</p>
					<div className="flex items-center gap-2 rounded border bg-background px-3 py-2">
						<code className="flex-1 break-all font-mono text-xs">{newToken.token}</code>
						<button
							type="button"
							onClick={() => copyToken(newToken.token)}
							className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
						>
							<CopyIcon className="h-4 w-4" />
						</button>
					</div>
					<Button variant="outline" size="sm" onClick={() => setNewToken(null)}>
						<Trans>Done</Trans>
					</Button>
				</div>
			)}

			<AddSystemDialog
				open={addOpen}
				setOpen={setAddOpen}
			/>
		</div>
	)
}
