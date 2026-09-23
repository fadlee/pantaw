import ContainersTable from "@/components/containers-table/containers-table"
import type { ContainerTableRow } from "@/components/containers-table/containers-table-columns"
import { FooterRepoLink } from "@/components/footer-repo-link"
import { Card, CardContent } from "@/components/ui/card"
import { Unit } from "@/lib/enums"
import { $systems } from "@/lib/stores"
import { decimalString, formatBytes, toFixedFloat } from "@/lib/utils"
import type { ChartData, ContainerStatsRecord } from "@/types"
import { Trans, useLingui } from "@lingui/react/macro"
import { useStore } from "@nanostores/react"
import { BoxIcon, CpuIcon, MemoryStickIcon, ServerIcon } from "lucide-react"
import { memo, useEffect, useMemo, useState } from "react"
import { cache, getStats, latestContainers } from "./system/chart-data"

export default memo(function Containers() {
	const systems = useStore($systems)
	const { t } = useLingui()
	const [loading, setLoading] = useState(true)
	const [containersBySystem, setContainersBySystem] = useState<Record<string, ContainerTableRow[]>>({})

	useEffect(() => {
		document.title = `${t`All Containers`} / Pantaw`
	}, [t])

	useEffect(() => {
		if (!systems.length) {
			setLoading(false)
			return
		}

		let active = true
		const fetchContainers = async () => {
			const results: Record<string, ContainerTableRow[]> = {}

			await Promise.allSettled(
				systems.map(async (sys) => {
					// The system page caches chart points (keyed by container name), not raw records
					let latest = latestContainers(
						cache.get(`${sys.id}_1h_container_stats`) as ChartData["containerData"] | undefined
					)
					if (!latest.length) {
						const records = await getStats<ContainerStatsRecord>("container_stats", sys.id, "1h")
						latest = records.at(-1)?.stats ?? []
					}
					if (latest.length > 0) {
						results[sys.id] = latest.map((c) => ({ ...c, system: sys.id }))
					}
				})
			)

			if (active) {
				setContainersBySystem(results)
				setLoading(false)
			}
		}

		fetchContainers()
		return () => {
			active = false
		}
	}, [systems])

	const allContainers = useMemo(() => {
		return Object.values(containersBySystem).flat()
	}, [containersBySystem])

	const statsSummary = useMemo(() => {
		let totalCpu = 0
		let totalMemMb = 0
		for (const c of allContainers) {
			totalCpu += c.c ?? 0
			totalMemMb += c.m ?? 0
		}
		const formattedMem = formatBytes(totalMemMb, false, Unit.Bytes, true)
		return {
			totalCount: allContainers.length,
			systemsCount: Object.keys(containersBySystem).length,
			totalCpu: toFixedFloat(totalCpu, 1),
			totalMemFormatted: `${decimalString(formattedMem.value, formattedMem.value >= 10 ? 1 : 2)} ${formattedMem.unit}`,
		}
	}, [allContainers, containersBySystem])

	return (
		<>
			<div className="flex flex-col gap-4">
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
					<Card>
						<CardContent className="p-4 flex items-center gap-3">
							<div className="p-2.5 rounded-lg bg-primary/10 text-primary">
								<BoxIcon className="size-5" />
							</div>
							<div>
								<div className="text-2xl font-bold tabular-nums">{statsSummary.totalCount}</div>
								<div className="text-xs text-muted-foreground">
									<Trans>Total Containers</Trans>
								</div>
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardContent className="p-4 flex items-center gap-3">
							<div className="p-2.5 rounded-lg bg-primary/10 text-primary">
								<ServerIcon className="size-5" />
							</div>
							<div>
								<div className="text-2xl font-bold tabular-nums">{statsSummary.systemsCount}</div>
								<div className="text-xs text-muted-foreground">
									<Trans>Systems with Containers</Trans>
								</div>
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardContent className="p-4 flex items-center gap-3">
							<div className="p-2.5 rounded-lg bg-primary/10 text-primary">
								<CpuIcon className="size-5" />
							</div>
							<div>
								<div className="text-2xl font-bold tabular-nums">{statsSummary.totalCpu}%</div>
								<div className="text-xs text-muted-foreground">
									<Trans>Total CPU Usage</Trans>
								</div>
							</div>
						</CardContent>
					</Card>

					<Card>
						<CardContent className="p-4 flex items-center gap-3">
							<div className="p-2.5 rounded-lg bg-primary/10 text-primary">
								<MemoryStickIcon className="size-5" />
							</div>
							<div>
								<div className="text-2xl font-bold tabular-nums">{statsSummary.totalMemFormatted}</div>
								<div className="text-xs text-muted-foreground">
									<Trans>Total Memory Usage</Trans>
								</div>
							</div>
						</CardContent>
					</Card>
				</div>

				<ContainersTable data={allContainers} showSystemColumn={true} />
			</div>
			<FooterRepoLink />
		</>
	)
})
