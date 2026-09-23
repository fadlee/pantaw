import { t } from "@lingui/core/macro"
import { Trans } from "@lingui/react/macro"
import { CheckIcon, CopyIcon, InfoIcon, PlusIcon } from "lucide-react"
import { useState, type Dispatch, type SetStateAction } from "react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SystemRecord } from "@/types"
import { apiClient } from "@/lib/api"
import * as systemsManager from "@/lib/systemsManager"
import { copyToClipboard, getHubURL } from "@/lib/utils"

type CreatedSystem = SystemRecord & { agent_token: string }

// ─── Code Snippet Box ─────────────────────────────────────────────────────────

function CodeSnippet({ code }: { code: string }) {
	const [copied, setCopied] = useState(false)

	function copy() {
		copyToClipboard(code).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}

	return (
		<div className="relative rounded-md border bg-muted/70 p-3 font-mono text-xs">
			<div className="flex items-start justify-between gap-2">
				<pre className="overflow-x-auto whitespace-pre leading-relaxed text-foreground/90 max-h-56 pr-8">
					<code>{code}</code>
				</pre>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={copy}
					className="absolute top-2 right-2 h-7 w-7 text-muted-foreground hover:text-foreground"
					title={t`Copy to clipboard`}
				>
					{copied ? <CheckIcon className="h-3.5 w-3.5 text-green-500" /> : <CopyIcon className="h-3.5 w-3.5" />}
				</Button>
			</div>
		</div>
	)
}

// ─── Token Reveal & Deployment Guide ──────────────────────────────────────────

function TokenRevealDialog({
	open,
	system,
	onClose,
}: {
	open: boolean
	system: CreatedSystem | null
	onClose: () => void
}) {
	const [copiedToken, setCopiedToken] = useState(false)

	if (!system) return null

	const hubUrl = getHubURL()
	const agentToken = system.agent_token

	const dockerRunCode = `docker run -d --name pantaw-agent \\
  --restart unless-stopped \\
  --net host \\
  --pid host \\
  -v /:/rootfs:ro \\
  -e HUB_URL="${hubUrl}" \\
  -e AGENT_TOKEN="${agentToken}" \\
  pantaw/agent:latest`

	const dockerComposeCode = `services:
  pantaw-agent:
    image: pantaw/agent:latest
    container_name: pantaw-agent
    restart: unless-stopped
    network_mode: host
    pid: host
    volumes:
      - /:/rootfs:ro
    environment:
      - HUB_URL=${hubUrl}
      - AGENT_TOKEN=${agentToken}`

	const binaryCode = `export HUB_URL="${hubUrl}"
export AGENT_TOKEN="${agentToken}"
./pantaw-agent`

	function copyToken() {
		copyToClipboard(agentToken).then(() => {
			setCopiedToken(true)
			setTimeout(() => setCopiedToken(false), 2000)
		})
	}

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						<Trans>System added: {system.name}</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Deploy the Pantaw agent on your server using one of the methods below.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 text-sm">
					{/* Token Box */}
					<div className="space-y-1.5">
						<Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
							<Trans>Agent Token</Trans>
						</Label>
						<div className="flex items-center gap-2 rounded-md border bg-muted/60 px-3 py-2">
							<code className="flex-1 break-all font-mono text-xs select-all">{agentToken}</code>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={copyToken}
								className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
								title={t`Copy token`}
							>
								{copiedToken ? (
									<CheckIcon className="h-3.5 w-3.5 text-green-500" />
								) : (
									<CopyIcon className="h-3.5 w-3.5" />
								)}
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							<Trans>Save this token now. It will not be shown again after closing.</Trans>
						</p>
					</div>

					{/* Auto-detect Notice */}
					<div className="flex items-start gap-2.5 rounded-md border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-foreground/90">
						<InfoIcon className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
						<div>
							<Trans>
								IP address and server details will be automatically detected when the agent sends its first metrics.
							</Trans>
						</div>
					</div>

					{/* Deployment Methods Tabs */}
					<div className="space-y-2 pt-1">
						<Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
							<Trans>Deployment Guide</Trans>
						</Label>
						<Tabs defaultValue="docker" className="w-full">
							<TabsList className="grid w-full grid-cols-3">
								<TabsTrigger value="docker">Docker Run</TabsTrigger>
								<TabsTrigger value="compose">Docker Compose</TabsTrigger>
								<TabsTrigger value="binary">Binary / Shell</TabsTrigger>
							</TabsList>
							<TabsContent value="docker" className="space-y-2 pt-2">
								<p className="text-xs text-muted-foreground">
									<Trans>Run the agent container directly with Docker:</Trans>
								</p>
								<CodeSnippet code={dockerRunCode} />
							</TabsContent>
							<TabsContent value="compose" className="space-y-2 pt-2">
								<p className="text-xs text-muted-foreground">
									<Trans>Add to your <code className="font-mono">docker-compose.yml</code>:</Trans>
								</p>
								<CodeSnippet code={dockerComposeCode} />
							</TabsContent>
							<TabsContent value="binary" className="space-y-2 pt-2">
								<p className="text-xs text-muted-foreground">
									<Trans>Run standalone Linux binary with environment variables:</Trans>
								</p>
								<CodeSnippet code={binaryCode} />
							</TabsContent>
						</Tabs>
					</div>
				</div>

				<DialogFooter className="pt-2">
					<Button onClick={onClose}>
						<Trans>Done</Trans>
					</Button>
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
				json: { name: name.trim() },
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
			setOpen(false)
			// Show token reveal & deployment guide
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
							<Trans>Enter a name to register a new system. Agent deployment instructions and token will be generated.</Trans>
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={submit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="sys-name"><Trans>System Name</Trans></Label>
							<Input
								id="sys-name"
								placeholder="e.g. web-production, db-server"
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								disabled={loading}
								autoFocus
							/>
							<p className="text-xs text-muted-foreground">
								<Trans>Host/IP will be automatically detected when the agent connects.</Trans>
							</p>
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
