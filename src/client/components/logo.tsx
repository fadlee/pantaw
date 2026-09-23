import { useId } from "react"

export function Logo({ className }: { className?: string }) {
	const id = useId()

	return (
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 135 34" className={className}>
			<defs>
				<linearGradient id={id} x1="0%" y1="20%" x2="100%" y2="120%">
					<stop offset="10%" style={{ stopColor: "#747bff" }} />
					<stop offset="90%" style={{ stopColor: "#24eb5c" }} />
				</linearGradient>
			</defs>
			<text
				x="0"
				y="27"
				fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
				fontSize="30"
				fontWeight="800"
				letterSpacing="-0.03em"
				className="duration-200 group-hover:opacity-0"
			>
				Pantaw
			</text>
			<text
				x="0"
				y="27"
				fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
				fontSize="30"
				fontWeight="800"
				letterSpacing="-0.03em"
				fill={`url(#${id})`}
				className="opacity-0 duration-200 group-hover:opacity-100"
			>
				Pantaw
			</text>
		</svg>
	)
}
