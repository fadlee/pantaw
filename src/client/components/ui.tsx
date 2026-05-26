import { useId } from "react"
import { cn } from "../lib/cn"

export function Button({
	className,
	variant = "primary",
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
	return (
		<button
			type={props.type ?? "button"}
			className={cn(
				"inline-flex items-center justify-center rounded-md px-4 py-2 font-medium text-sm transition-colors",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400",
				"disabled:cursor-not-allowed disabled:opacity-50",
				variant === "primary" && "bg-zinc-100 text-zinc-900 hover:bg-zinc-200 active:bg-zinc-300",
				variant === "ghost" && "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
				className
			)}
			{...props}
		/>
	)
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			className={cn(
				"flex h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100",
				"placeholder:text-zinc-500",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:border-zinc-600",
				"disabled:cursor-not-allowed disabled:opacity-50",
				className
			)}
			{...props}
		/>
	)
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: konsumen menyediakan htmlFor.
		<label className={cn("font-medium text-sm text-zinc-300", className)} {...props} />
	)
}

export function FormField({
	label,
	error,
	children,
}: {
	label: string
	error?: string
	children: (props: { id: string }) => React.ReactNode
}) {
	const id = useId()
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children({ id })}
			{error && <p className="text-rose-400 text-xs">{error}</p>}
		</div>
	)
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				"w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl backdrop-blur",
				className
			)}
			{...props}
		/>
	)
}
