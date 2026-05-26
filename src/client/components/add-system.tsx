import { t } from "@lingui/core/macro"
import { Trans } from "@lingui/react/macro"
import { CopyIcon, PlusIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SystemRecord } from "@/types"
import { apiClient } from "@/lib/api"
import * as systemsManager from "@/lib/systemsManager"
import type { Dispatch, SetStateAction } from "react"

type CreatedSystem = SystemRecord & { agent_token: string }

// ─── Token Reveal ─────────────────────────────────────────────────────────────

function TokenRevealDialog({
	open,
	system,
	onClose,
}: {
	open: boolean
	system: CreatedSystem | null
	onClose: () => void
}) {
	const [copied, setCopied] = useState(false)

	if (!system) return null

	function copy() {
		navigator.clipboard.writeText(system!.agent_token).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>
						<Trans>System added: {system.name}</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Copy the agent token below. It will not be shown again after closing this dialog.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
						<code className="flex-1 break-all font-mono text-xs">{system.agent_token}</code>
						<button
							type="button"
							onClick={copy}
							className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
							aria-label={t`Copy token`}
						>
							<CopyIcon className="h-4 w-4" />
						</button>
					</div>
					{copied && <p className="text-xs text-green-500"><Trans>Token copied!</Trans></p>}
					<p className="text-xs text-muted-foreground">
						<Trans>
							Use this token as <code className="font-mono">AGENT_TOKEN</code> in your Pantaw agent configuration.
						</Trans>
					</p>
				</div>
				<DialogFooter>
					<Button onClick={onClose}><Trans>Done</Trans></Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// ─── Add System Dialog ────────────────────────────────────────────────────────

export function AddSystemDialog({
	open,
	setOpen,
}: {
	open: boolean
	setOpen: Dispatch<SetStateAction<boolean>>
}) {
	const [name, setName] = useState("")
	const [host, setHost] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [createdSystem, setCreatedSystem] = useState<CreatedSystem | null>(null)
	const [tokenOpen, setTokenOpen] = useState(false)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setLoading(true)
		try {
			const res = await apiClient.api.v1.systems.$post({
				json: { name: name.trim(), host: host.trim() },
			})
			const status = res.status
			if (!res.ok) {
				if (status === 409) setError(t`System name already taken`)
				else setError(t`Failed to create system (${status})`)
				return
			}
			const data = (await res.json()) as CreatedSystem
			// Add to store
			systemsManager.add(data)
			// Reset form + close
			setName("")
			setHost("")
			setOpen(false)
			// Show token reveal
			setCreatedSystem(data)
			setTokenOpen(true)
		} catch {
			setError(t`Network error`)
		} finally {
			setLoading(false)
		}
	}

	return (
		<>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle><Trans>Add System</Trans></DialogTitle>
						<DialogDescription>
							<Trans>Add a new server to monitor. An agent token will be generated.</Trans>
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={submit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="sys-name"><Trans>Name</Trans></Label>
							<Input
								id="sys-name"
								placeholder="web-server-1"
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								disabled={loading}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="sys-host"><Trans>Host / IP</Trans></Label>
							<Input
								id="sys-host"
								placeholder="192.168.1.10"
								required
								value={host}
								onChange={(e) => setHost(e.target.value)}
								disabled={loading}
							/>
						</div>
						{error && (
							<p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive text-sm">
								{error}
							</p>
						)}
						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit" disabled={loading}>
								{loading ? <Trans>Creating…</Trans> : <><PlusIcon className="mr-1.5 h-4 w-4" /><Trans>Create</Trans></>}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<TokenRevealDialog
				open={tokenOpen}
				system={createdSystem}
				onClose={() => {
					setTokenOpen(false)
					setCreatedSystem(null)
				}}
			/>
		</>
	)
}

// ─── System Dialog (edit) — stub untuk post-MVP ───────────────────────────────

export function SystemDialog(_props: {
	system: SystemRecord
	setOpen: Dispatch<SetStateAction<boolean>>
}) {
	return null
}

export default function AddSystem() {
	return null
}
