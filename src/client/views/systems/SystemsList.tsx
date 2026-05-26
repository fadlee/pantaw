import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, Plus, RefreshCw, Server, Trash2 } from "lucide-react"
import { useState } from "react"
import { ConfirmDialog, Dialog } from "../../components/Dialog"
import { Button, Card, FormField, Input } from "../../components/ui"
import { api } from "../../lib/api"
import { cn } from "../../lib/cn"

// ─── Types ───────────────────────────────────────────────────────────────────

type SystemStatus = "up" | "down" | "unknown"

type System = {
	id: string
	name: string
	host: string
	timeout_seconds: number
	status: SystemStatus
	last_seen: number | null
	created_at: number
}

type CreatedSystem = System & { agent_token: string }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
	const diff = Math.floor(Date.now() / 1000) - ts
	if (diff < 60) return `${diff}s ago`
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
	return `${Math.floor(diff / 86400)}d ago`
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SystemStatus }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-xs",
				status === "up" && "border-emerald-900/50 bg-emerald-950/50 text-emerald-400",
				status === "down" && "border-rose-900/50 bg-rose-950/50 text-rose-400",
				status === "unknown" && "border-zinc-700/50 bg-zinc-800/50 text-zinc-400"
			)}
		>
			<span
				className={cn(
					"h-1.5 w-1.5 rounded-full",
					status === "up" && "bg-emerald-400",
					status === "down" && "bg-rose-400",
					status === "unknown" && "bg-zinc-400"
				)}
			/>
			{status}
		</span>
	)
}

// ─── Token reveal dialog ──────────────────────────────────────────────────────

function TokenRevealDialog({
	token,
	systemName,
	onClose,
}: {
	token: string
	systemName: string
	onClose: () => void
}) {
	const [copied, setCopied] = useState(false)

	function copy() {
		navigator.clipboard.writeText(token).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}

	return (
		<Dialog open title={`Token untuk ${systemName}`} onClose={onClose} className="max-w-lg">
			<div className="space-y-4">
				<p className="text-sm text-zinc-400">
					Salin token ini sekarang.{" "}
					<span className="font-medium text-rose-400">
						Token tidak akan ditampilkan lagi setelah dialog ini ditutup.
					</span>
				</p>
				<div className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2">
					<code className="flex-1 break-all font-mono text-xs text-zinc-200">{token}</code>
					<button
						type="button"
						onClick={copy}
						className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						aria-label="Salin token"
					>
						<Copy className="h-4 w-4" />
					</button>
				</div>
				{copied && <p className="text-emerald-400 text-xs">Token disalin!</p>}
				<p className="text-xs text-zinc-500">
					Gunakan token ini sebagai <code className="font-mono">AGENT_TOKEN</code> di konfigurasi Pantaw agent.
				</p>
				<div className="flex justify-end">
					<Button onClick={onClose}>Sudah disalin, tutup</Button>
				</div>
			</div>
		</Dialog>
	)
}

// ─── Add system modal ─────────────────────────────────────────────────────────

function AddSystemModal({
	open,
	onClose,
	onCreated,
}: {
	open: boolean
	onClose: () => void
	onCreated: (system: CreatedSystem) => void
}) {
	const qc = useQueryClient()
	const [name, setName] = useState("")
	const [host, setHost] = useState("")
	const [error, setError] = useState<string | null>(null)

	const mutation = useMutation({
		mutationFn: async (input: { name: string; host: string }) => {
			const res = await api.api.v1.systems.$post({ json: input })
			const status = res.status
			if (!res.ok) {
				if (status === 409) throw new Error("Nama system sudah dipakai.")
				throw new Error(`Gagal membuat system (${status}).`)
			}
			return res.json()
		},
		onSuccess: async (data) => {
			await qc.invalidateQueries({ queryKey: ["systems"] })
			setName("")
			setHost("")
			onClose()
			onCreated(data as CreatedSystem)
		},
		onError: (e: Error) => setError(e.message),
	})

	function submit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		mutation.mutate({ name: name.trim(), host: host.trim() })
	}

	return (
		<Dialog open={open} onClose={onClose} title="Tambah system">
			<form onSubmit={submit} className="flex flex-col gap-4">
				<FormField label="Nama">
					{({ id }) => (
						<Input
							id={id}
							placeholder="web-server-1"
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
							disabled={mutation.isPending}
						/>
					)}
				</FormField>
				<FormField label="Host / IP">
					{({ id }) => (
						<Input
							id={id}
							placeholder="192.168.1.10"
							required
							value={host}
							onChange={(e) => setHost(e.target.value)}
							disabled={mutation.isPending}
						/>
					)}
				</FormField>
				{error && (
					<p className="rounded-md border border-rose-900/50 bg-rose-950/40 px-3 py-2 text-rose-300 text-sm">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-3">
					<Button variant="ghost" type="button" onClick={onClose} disabled={mutation.isPending}>
						Batal
					</Button>
					<Button type="submit" disabled={mutation.isPending}>
						{mutation.isPending ? "Membuat…" : "Buat system"}
					</Button>
				</div>
			</form>
		</Dialog>
	)
}

// ─── Systems list ─────────────────────────────────────────────────────────────

export function SystemsList() {
	const qc = useQueryClient()
	const [addOpen, setAddOpen] = useState(false)
	const [newSystem, setNewSystem] = useState<CreatedSystem | null>(null)
	const [deleteTarget, setDeleteTarget] = useState<System | null>(null)

	const {
		data: systems = [],
		isLoading,
		isError,
	} = useQuery({
		queryKey: ["systems"],
		queryFn: async (): Promise<System[]> => {
			const res = await api.api.v1.systems.$get()
			if (!res.ok) throw new Error("failed to fetch systems")
			return (await res.json()) as System[]
		},
		refetchInterval: 30_000,
	})

	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			const res = await api.api.v1.systems[":id"].$delete({ param: { id } })
			if (!res.ok) throw new Error("Gagal menghapus system.")
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["systems"] })
			setDeleteTarget(null)
		},
	})

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Server className="h-5 w-5 text-zinc-400" />
					<h2 className="font-semibold text-zinc-100">Systems</h2>
					<span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{systems.length}</span>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => qc.invalidateQueries({ queryKey: ["systems"] })}
						className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						aria-label="Refresh"
					>
						<RefreshCw className="h-4 w-4" />
					</button>
					<Button onClick={() => setAddOpen(true)}>
						<Plus className="mr-1.5 h-4 w-4" />
						Tambah system
					</Button>
				</div>
			</div>

			{/* Content */}
			{isLoading && <p className="py-8 text-center text-sm text-zinc-500">Memuat…</p>}
			{isError && <p className="py-8 text-center text-sm text-rose-400">Gagal memuat systems.</p>}
			{!isLoading && !isError && systems.length === 0 && (
				<Card className="flex flex-col items-center gap-3 py-12 text-center max-w-none">
					<Server className="h-10 w-10 text-zinc-600" />
					<p className="font-medium text-zinc-300">Belum ada system</p>
					<p className="text-sm text-zinc-500">Tambah server pertama untuk mulai memantau.</p>
					<Button onClick={() => setAddOpen(true)}>
						<Plus className="mr-1.5 h-4 w-4" />
						Tambah system
					</Button>
				</Card>
			)}
			{systems.length > 0 && (
				<div className="overflow-hidden rounded-lg border border-zinc-800">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-zinc-800 border-b bg-zinc-900/50">
								<th className="px-4 py-3 text-left font-medium text-zinc-400">Nama</th>
								<th className="px-4 py-3 text-left font-medium text-zinc-400">Host</th>
								<th className="px-4 py-3 text-left font-medium text-zinc-400">Status</th>
								<th className="px-4 py-3 text-left font-medium text-zinc-400">Last seen</th>
								<th className="px-4 py-3" />
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800">
							{systems.map((sys) => (
								<tr key={sys.id} className="hover:bg-zinc-800/30">
									<td className="px-4 py-3 font-medium text-zinc-100">{sys.name}</td>
									<td className="px-4 py-3 font-mono text-xs text-zinc-400">{sys.host}</td>
									<td className="px-4 py-3">
										<StatusBadge status={sys.status} />
									</td>
									<td className="px-4 py-3 text-zinc-400">{sys.last_seen ? relativeTime(sys.last_seen) : "—"}</td>
									<td className="px-4 py-3 text-right">
										<button
											type="button"
											onClick={() => setDeleteTarget(sys)}
											className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400"
											aria-label={`Hapus ${sys.name}`}
										>
											<Trash2 className="h-4 w-4" />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{/* Modals */}
			<AddSystemModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(s) => setNewSystem(s)} />
			{newSystem && (
				<TokenRevealDialog
					token={newSystem.agent_token}
					systemName={newSystem.name}
					onClose={() => setNewSystem(null)}
				/>
			)}
			<ConfirmDialog
				open={deleteTarget !== null}
				onClose={() => setDeleteTarget(null)}
				onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
				isPending={deleteMutation.isPending}
				title="Hapus system"
				description={`Yakin ingin menghapus "${deleteTarget?.name}"? Semua metrik dan token terkait akan ikut terhapus.`}
			/>
		</div>
	)
}
