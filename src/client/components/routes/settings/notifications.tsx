/**
 * Notifications settings — tampilkan info tentang webhook alerts di Pantaw.
 * Alert webhook dikonfigurasi per-alert di halaman system detail.
 */
import type { UserSettings } from "@/types"
import { Trans } from "@lingui/react/macro"
import { BellIcon, ExternalLinkIcon } from "lucide-react"
import { $router, Link } from "@/components/router"
import { getPagePath } from "@nanostores/router"

export default function Notifications(_props: { userSettings: UserSettings }) {
	return (
		<div className="space-y-6">
			<div>
				<h3 className="text-lg font-medium"><Trans>Notifications</Trans></h3>
				<p className="text-sm text-muted-foreground">
					<Trans>Pantaw sends notifications via webhooks configured per alert.</Trans>
				</p>
			</div>
			<div className="rounded-lg border p-4 space-y-3">
				<div className="flex items-start gap-3">
					<BellIcon className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
					<div className="space-y-1">
						<p className="text-sm font-medium"><Trans>Webhook alerts</Trans></p>
						<p className="text-sm text-muted-foreground">
							<Trans>
								Each alert can have its own webhook URL (Telegram, Slack, Discord, etc.).
								Configure webhooks when creating or editing alerts on the system detail page.
							</Trans>
						</p>
					</div>
				</div>
			</div>
			<div className="rounded-lg border p-4 space-y-3">
				<p className="text-sm font-medium"><Trans>How to set up alerts</Trans></p>
				<ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
					<li><Trans>Go to a system detail page</Trans></li>
					<li><Trans>Click the bell icon to open alerts</Trans></li>
					<li><Trans>Add an alert with a webhook URL</Trans></li>
					<li><Trans>Pantaw will POST to the URL when the threshold is breached</Trans></li>
				</ol>
				<Link
					href={getPagePath($router, "home")}
					className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
				>
					<ExternalLinkIcon className="h-3.5 w-3.5" />
					<Trans>Go to dashboard</Trans>
				</Link>
			</div>
		</div>
	)
}
