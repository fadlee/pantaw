import { $router, Link } from "@/components/router"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/use-toast"
import { alertInfo } from "@/lib/alerts"
import { apiClient } from "@/lib/api"
import { $alerts, $systems } from "@/lib/stores"
import { cn, debounce } from "@/lib/utils"
import type { AlertInfo, AlertRecord, SystemRecord } from "@/types"
import { t } from "@lingui/core/macro"
import { Plural, Trans } from "@lingui/react/macro"
import { useStore } from "@nanostores/react"
import { getPagePath } from "@nanostores/router"
import { ChevronDownIcon, GlobeIcon, ServerIcon } from "lucide-react"
import { Suspense, lazy, memo, useMemo, useState } from "react"

const Slider = lazy(() => import("@/components/ui/slider"))

const alertDebounce = 400

const alertKeys = Object.keys(alertInfo) as (keyof typeof alertInfo)[]

const failedUpdateToast = (error: unknown) => {
	console.error(error)
	toast({
		title: t`Failed to update alert`,
		description: t`Please check logs for more details.`,
		variant: "destructive",
	})
}

// ─── Pantaw alert metric mapping ─────────────────────────────────────────────
// Beszel alert names → Pantaw metric names

const alertKeyToMetric: Record<string, string> = {
	CPU: "cpu",
	Memory: "mem",
	Disk: "disk",
	Temperature: "temp",
	Status: "status",
	// Bandwidth, GPU, LoadAvg* tidak ada di Pantaw MVP — skip
}

const metricToAlertKey: Record<string, string> = Object.fromEntries(
	Object.entries(alertKeyToMetric).map(([k, v]) => [v, k])
)

type PantawAlert = {
	id: string
	system_id: string
	metric: string
	threshold: number
	operator: string
	duration_s: number
	enabled: boolean
	webhook_url: string | null
	last_fired: number | null
}

function toAlertRecord(a: PantawAlert): AlertRecord {
	return {
		id: a.id,
		system: a.system_id,
		name: metricToAlertKey[a.metric] ?? a.metric,
		triggered: a.last_fired !== null,
		value: a.threshold,
		min: Math.round(a.duration_s / 60),
	}
}

/** Fetch alerts untuk satu system dan update store */
async function refreshSystemAlerts(systemId: string) {
	try {
		const res = await apiClient.api.v1.alerts.$get({ query: { system_id: systemId } } as Parameters<typeof apiClient.api.v1.alerts.$get>[0])
		if (!res.ok) return
		const data = (await res.json()) as PantawAlert[]
		const map = new Map<string, AlertRecord>()
		for (const a of data) {
			const record = toAlertRecord(a)
			map.set(record.name, record)
		}
		$alerts.setKey(systemId, map)
	} catch (e) {
		console.error("refreshSystemAlerts", e)
	}
}

/** Upsert alert: create jika belum ada, update jika sudah ada */
const upsertAlerts = debounce(
	async ({ name, value, min, systems }: { name: string; value: number; min: number; systems: string[] }) => {
		const metric = alertKeyToMetric[name]
		if (!metric) return // metric tidak didukung di Pantaw MVP

		const duration_s = min * 60
		const operator = alertInfo[name as keyof typeof alertInfo]?.invert ? "lt" : "gt"

		try {
			await Promise.all(
				systems.map(async (systemId) => {
					// Cek apakah alert sudah ada
					const existing = $alerts.get()[systemId]?.get(name)
					if (existing?.id) {
						// Update existing
						await apiClient.api.v1.alerts[":id"].$put({
							param: { id: existing.id },
							json: { threshold: value, duration_s, enabled: true },
						})
					} else {
						// Create new
						const res = await apiClient.api.v1.alerts.$post({
							json: {
								system_id: systemId,
								metric: metric as "cpu" | "mem" | "disk" | "temp" | "status",
								threshold: value,
								operator: operator as "gt" | "lt" | "eq",
								duration_s,
								enabled: true,
							},
						})
						if (res.ok) {
							const created = (await res.json()) as PantawAlert
							const record = toAlertRecord(created)
							const current = $alerts.get()[systemId] ?? new Map()
							const updated = new Map(current)
							updated.set(record.name, record)
							$alerts.setKey(systemId, updated)
						}
					}
					await refreshSystemAlerts(systemId)
				})
			)
		} catch (error) {
			failedUpdateToast(error)
		}
	},
	alertDebounce
)

/** Delete alerts untuk satu atau banyak system */
const deleteAlerts = debounce(async ({ name, systems }: { name: string; systems: string[] }) => {
	try {
		await Promise.all(
			systems.map(async (systemId) => {
				const existing = $alerts.get()[systemId]?.get(name)
				if (!existing?.id) return
				await apiClient.api.v1.alerts[":id"].$delete({ param: { id: existing.id } })
				const current = $alerts.get()[systemId] ?? new Map()
				const updated = new Map(current)
				updated.delete(name)
				$alerts.setKey(systemId, updated)
			})
		)
	} catch (error) {
		failedUpdateToast(error)
	}
}, alertDebounce)

export const AlertDialogContent = memo(function AlertDialogContent({ system }: { system: SystemRecord }) {
	const alerts = useStore($alerts)
	const systems = useStore($systems)
	const [overwriteExisting, setOverwriteExisting] = useState<boolean | "indeterminate">(false)
	const [currentTab, setCurrentTab] = useState("system")
	const [copyKey, setCopyKey] = useState(0)

	const systemAlerts = alerts[system.id] ?? new Map()

	const systemsWithAlerts = useMemo(
		() => systems.filter((s) => s.id !== system.id && alerts[s.id]?.size),
		[systems, alerts, system.id]
	)

	async function copyAlertsFromSystem(sourceSystemId: string) {
		const sourceAlerts = $alerts.get()[sourceSystemId]
		if (!sourceAlerts?.size) return
		try {
			const currentTargetAlerts = $alerts.get()[system.id] ?? new Map()
			const namesToDelete = Array.from(currentTargetAlerts.keys()).filter((name) => !sourceAlerts.has(name))

			await Promise.all([
				...Array.from(sourceAlerts.values()).map(({ name, value, min }) =>
					upsertAlerts({ name, value, min, systems: [system.id] })
				),
				...namesToDelete.map((name) =>
					deleteAlerts({ name, systems: [system.id] })
				),
			])

			const newSystemAlerts = new Map<string, AlertRecord>()
			for (const alert of sourceAlerts.values()) {
				newSystemAlerts.set(alert.name, { ...alert, system: system.id, triggered: false })
			}
			$alerts.setKey(system.id, newSystemAlerts)
			setCopyKey((k) => k + 1)
		} catch (error) {
			failedUpdateToast(error)
		}
	}

	const alertsWhenGlobalSelected = useMemo(() => {
		return currentTab === "global" ? structuredClone(alerts) : alerts
	}, [currentTab])

	return (
		<>
			<DialogHeader>
				<DialogTitle className="text-xl">
					<Trans>Alerts</Trans>
				</DialogTitle>
				<DialogDescription>
					<Trans>
						See{" "}
						<Link href={getPagePath($router, "settings", { name: "notifications" })} className="link">
							notification settings
						</Link>{" "}
						to configure how you receive alerts.
					</Trans>
				</DialogDescription>
			</DialogHeader>
			<Tabs defaultValue="system" onValueChange={setCurrentTab}>
				<div className="flex items-center justify-between mb-1 -mt-0.5">
					<TabsList>
						<TabsTrigger value="system">
							<ServerIcon className="me-2 h-3.5 w-3.5" />
							<span className="truncate max-w-60">{system.name}</span>
						</TabsTrigger>
						<TabsTrigger value="global">
							<GlobeIcon className="me-1.5 h-3.5 w-3.5" />
							<Trans>All Systems</Trans>
						</TabsTrigger>
					</TabsList>
					{systemsWithAlerts.length > 0 && currentTab === "system" && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" className="text-muted-foreground text-xs gap-1.5">
									<Trans context="Copy alerts from another system">Copy from</Trans>
									<ChevronDownIcon className="h-3.5 w-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="max-h-100 overflow-auto">
								{systemsWithAlerts.map((s) => (
									<DropdownMenuItem key={s.id} className="min-w-44" onSelect={() => copyAlertsFromSystem(s.id)}>
										{s.name}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
				<TabsContent value="system">
					<div key={copyKey} className="grid gap-3">
						{alertKeys.map((name) => (
							<AlertContent
								key={name}
								alertKey={name}
								data={alertInfo[name as keyof typeof alertInfo]}
								alert={systemAlerts.get(name)}
								system={system}
							/>
						))}
					</div>
				</TabsContent>
				<TabsContent value="global">
					<label
						htmlFor="ovw"
						className="mb-3 flex gap-2 items-center justify-center cursor-pointer border rounded-sm py-3 px-4 border-destructive text-destructive font-semibold text-sm"
					>
						<Checkbox
							id="ovw"
							className="text-destructive border-destructive data-[state=checked]:bg-destructive"
							checked={overwriteExisting}
							onCheckedChange={setOverwriteExisting}
						/>
						<Trans>Overwrite existing alerts</Trans>
					</label>
					<div className="grid gap-3">
						{alertKeys.map((name) => (
							<AlertContent
								key={name}
								alertKey={name}
								system={system}
								alert={systemAlerts.get(name)}
								data={alertInfo[name as keyof typeof alertInfo]}
								global={true}
								overwriteExisting={!!overwriteExisting}
								initialAlertsState={alertsWhenGlobalSelected}
							/>
						))}
					</div>
				</TabsContent>
			</Tabs>
		</>
	)
})

export function AlertContent({
	alertKey,
	data: alertData,
	system,
	alert,
	global = false,
	overwriteExisting = false,
	initialAlertsState = {},
}: {
	alertKey: string
	data: AlertInfo
	system: SystemRecord
	alert?: AlertRecord
	global?: boolean
	overwriteExisting?: boolean
	initialAlertsState?: Record<string, Map<string, AlertRecord>>
}) {
	const { name } = alertData

	// Skip alert types not supported in Pantaw MVP
	const metric = alertKeyToMetric[alertKey]
	if (!metric) return null

	const singleDescription = alertData.singleDesc?.()

	const [checked, setChecked] = useState(global ? false : !!alert)
	const [min, setMin] = useState(alert?.min || 10)
	const [value, setValue] = useState(alert?.value || (singleDescription ? 0 : (alertData.start ?? 80)))

	const Icon = alertData.icon

	function getSystemIds(): string[] {
		if (!global) return [system.id]
		const allSystems = $systems.get()
		return allSystems
			.filter((s) => overwriteExisting || !initialAlertsState[s.id]?.has(alertKey))
			.map((s) => s.id)
	}

	function sendUpsert(min: number, value: number) {
		const systems = getSystemIds()
		if (systems.length) upsertAlerts({ name: alertKey, value, min, systems })
	}

	return (
		<div className="rounded-lg border border-muted-foreground/15 hover:border-muted-foreground/20 transition-colors duration-100 group">
			<label
				htmlFor={`s${name}`}
				className={cn("flex flex-row items-center justify-between gap-4 cursor-pointer p-4", {
					"pb-0": checked,
				})}
			>
				<div className="grid gap-1 select-none">
					<p className="font-semibold flex gap-3 items-center">
						<Icon className="h-4 w-4 opacity-85" /> {alertData.name()}
					</p>
					{!checked && <span className="block text-sm text-muted-foreground">{alertData.desc()}</span>}
				</div>
				<Switch
					id={`s${name}`}
					checked={checked}
					onCheckedChange={(newChecked) => {
						setChecked(newChecked)
						if (newChecked) {
							sendUpsert(min, value)
						} else {
							deleteAlerts({ name: alertKey, systems: getSystemIds() })
							if (overwriteExisting) {
								for (const curAlerts of Object.values(initialAlertsState)) {
									curAlerts.delete(alertKey)
								}
							}
						}
					}}
				/>
			</label>
			{checked && (
				<div className="grid sm:grid-cols-2 mt-1.5 gap-5 px-4 pb-5 tabular-nums text-muted-foreground">
					<Suspense fallback={<div className="h-10" />}>
						{!singleDescription && (
							<div>
								<p id={`v${name}`} className="text-sm block h-6">
									{alertData.invert ? (
										<Trans>
											Average drops below{" "}
											<strong className="text-foreground">
												{value}
												{alertData.unit}
											</strong>
										</Trans>
									) : (
										<Trans>
											Average exceeds{" "}
											<strong className="text-foreground">
												{value}
												{alertData.unit}
											</strong>
										</Trans>
									)}
								</p>
								<div className="flex gap-3 items-center">
									<Slider
										aria-labelledby={`v${name}`}
										value={[value]}
										onValueCommit={(val) => sendUpsert(min, val[0])}
										onValueChange={(val) => setValue(val[0])}
										step={alertData.step ?? 1}
										min={alertData.min ?? 1}
										max={alertData.max ?? 99}
									/>
									<Input
										type="number"
										value={value}
										onChange={(e) => {
											let val = Number.parseFloat(e.target.value)
											if (!Number.isNaN(val)) {
												if (alertData.max != null) val = Math.min(val, alertData.max)
												if (alertData.min != null) val = Math.max(val, alertData.min)
												setValue(val)
												sendUpsert(min, val)
											}
										}}
										step={alertData.step ?? 1}
										min={alertData.min ?? 1}
										max={alertData.max ?? 99}
										className="w-16 h-8 text-center px-1"
									/>
								</div>
							</div>
						)}
						<div className={cn(singleDescription && "col-span-full lowercase")}>
							<p id={`t${name}`} className="text-sm block h-6 first-letter:uppercase">
								{singleDescription && <>{singleDescription} </>}
								<Trans>
									For <strong className="text-foreground">{min}</strong>{" "}
									<Plural value={min} one="minute" other="minutes" />
								</Trans>
							</p>
							<div className="flex gap-3 items-center">
								<Slider
									aria-labelledby={`t${name}`}
									value={[min]}
									onValueCommit={(val) => sendUpsert(val[0], value)}
									onValueChange={(val) => setMin(val[0])}
									min={1}
									max={60}
								/>
								<Input
									type="number"
									value={min}
									onChange={(e) => {
										let val = Number.parseInt(e.target.value, 10)
										if (!Number.isNaN(val)) {
											val = Math.max(1, Math.min(val, 60))
											setMin(val)
											sendUpsert(val, value)
										}
									}}
									min={1}
									max={60}
									className="w-16 h-8 text-center px-1"
								/>
							</div>
						</div>
					</Suspense>
				</div>
			)}
		</div>
	)
}
