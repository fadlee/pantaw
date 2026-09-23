import { $newVersion } from "@/lib/stores"
import { Trans } from "@lingui/react/macro"
import { useStore } from "@nanostores/react"
import { GithubIcon } from "lucide-react"
import { Separator } from "./ui/separator"

export function FooterRepoLink() {
	const newVersion = useStore($newVersion)
	return (
		<div className="flex gap-1.5 justify-end items-center pe-3 sm:pe-6 mt-3.5 mb-4 text-xs opacity-80">
			<a
				href="https://github.com/fadlee/pantaw"
				target="_blank"
				className="flex items-center gap-1 text-muted-foreground hover:text-foreground duration-75"
				rel="noreferrer noopener"
			>
				<GithubIcon className="h-3 w-3" /> Pantaw
			</a>
			{newVersion?.v && (
				<>
					<Separator orientation="vertical" className="h-2.5 bg-muted-foreground opacity-70" />
					<a
						href={newVersion.url}
						target="_blank"
						className="text-yellow-500 hover:text-yellow-400 duration-75"
						rel="noreferrer noopener"
					>
						<Trans context="New version available">{newVersion.v} available</Trans>
					</a>
				</>
			)}
		</div>
	)
}
