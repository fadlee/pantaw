import { X } from "lucide-react"
import { useEffect } from "react"
import { cn } from "../lib/cn"
import { Button } from "./ui"

export function Dialog({
	open,
	onClose,
	title,
	children,
	className,
}: {
	open: boolean
	onClose: () => void
	title: string
	children: React.ReactNode
	className?: string
}) {
	useEffect(() => {
		if (!open) return
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose()
		}
		window.addEventListener("keydown", handler)
		return () => window.removeEventListener("keydown", handler)
	}, [open, onClose])

	if (!open) return null

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			{/* Backdrop */}
			<button
				type="button"
				className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
				onClick={onClose}
				aria-label="Tutup dialog"
				tabIndex={-1}
			/>
			{/* Panel */}
			<dialog
				open
				className={cn(
					"relative z-10 m-0 w-full max-w-md rounded-lg border border-zinc-800",
					"bg-zinc-900 p-6 shadow-2xl",
					className
				)}
			>
				<div className="mb-5 flex items-center justify-between">
					<h2 className="font-semibold text-lg text-zinc-100">{title}</h2>
					<button
						type="button"
						onClick={onClose}
						className="rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						aria-label="Tutup"
					>
						<X className="h-5 w-5" />
					</button>
				</div>
				{children}
			</dialog>
		</div>
	)
}

export function ConfirmDialog({
	open,
	onClose,
	onConfirm,
	title,
	description,
	confirmLabel = "Hapus",
	isPending = false,
}: {
	open: boolean
	onClose: () => void
	onConfirm: () => void
	title: string
	description: string
	confirmLabel?: string
	isPending?: boolean
}) {
	return (
		<Dialog open={open} onClose={onClose} title={title}>
			<p className="mb-6 text-sm text-zinc-400">{description}</p>
			<div className="flex justify-end gap-3">
				<Button variant="ghost" onClick={onClose} disabled={isPending}>
					Batal
				</Button>
				<Button
					onClick={onConfirm}
					disabled={isPending}
					className="bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800"
				>
					{isPending ? "Menghapus…" : confirmLabel}
				</Button>
			</div>
		</Dialog>
	)
}
