import { FooterRepoLink } from "@/components/footer-repo-link"
import { Link } from "@/components/router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SystemStatus } from "@/lib/enums"
import { $systems } from "@/lib/stores"
import { cn } from "@/lib/utils"
import { Trans, useLingui } from "@lingui/react/macro"
import { useStore } from "@nanostores/react"
import { ArrowRightIcon, HardDriveIcon, InfoIcon, ServerIcon, ShieldCheckIcon } from "lucide-react"
import { memo, useEffect } from "react"

export default memo(function Smart() {
	const systems = useStore($systems)
	const { t } = useLingui()

	useEffect(() => {
		document.title = `${t`SMART Monitoring`} / Pantaw`
	}, [t])

	return (
		<>
			<div className="flex flex-col gap-4">
				<Card>
					<CardHeader>
						<div className="flex items-center gap-2.5">
							<div className="p-2 rounded-lg bg-primary/10 text-primary">
								<ShieldCheckIcon className="size-5" />
							</div>
							<div>
								<CardTitle className="text-lg">
									<Trans>S.M.A.R.T. Disk Health Monitoring</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>Self-Monitoring, Analysis and Reporting Technology for connected storage devices</Trans>
								</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="flex items-start gap-3 p-3.5 rounded-lg border bg-muted/30 text-sm">
							<InfoIcon className="size-5 text-muted-foreground shrink-0 mt-0.5" />
							<div className="space-y-1 text-muted-foreground leading-relaxed">
								<p>
									<Trans>
										S.M.A.R.T. metrics provide hardware-level indicators of disk reliability, temperature, read/write error rates, and remaining lifespan.
									</Trans>
								</p>
								<p className="text-xs">
									<Trans>
										To enable SMART monitoring on Linux/BSD/macOS hosts, ensure the agent runs with appropriate permissions or access to smartctl.
									</Trans>
								</p>
							</div>
						</div>

						<div className="space-y-2">
							<h3 className="text-sm font-medium">
								<Trans>Systems Overview</Trans>
							</h3>
							<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
								{systems.map((system) => {
									const isUp = system.status === SystemStatus.Up
									return (
										<Link
											key={system.id}
											href={`/system/${system.id}`}
											className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
										>
											<div className="flex items-center gap-2.5 min-w-0">
												<ServerIcon className="size-4 text-muted-foreground shrink-0" />
												<div className="min-w-0">
													<div className="font-medium text-sm truncate">{system.name}</div>
													<div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
														<span
															className={cn(
																"size-2 rounded-full",
																isUp ? "bg-green-500" : "bg-red-500"
															)}
														/>
														<span>{isUp ? t`Online` : t`Offline`}</span>
													</div>
												</div>
											</div>
											<ArrowRightIcon className="size-4 text-muted-foreground shrink-0" />
										</Link>
									)
								})}
								{!systems.length && (
									<div className="col-span-full py-8 text-center text-sm text-muted-foreground">
										<Trans>No systems registered yet.</Trans>
									</div>
								)}
							</div>
						</div>
					</CardContent>
				</Card>
			</div>
			<FooterRepoLink />
		</>
	)
})
