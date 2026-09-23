import { Button } from "@/components/ui/button"
import { Unit } from "@/lib/enums"
import { $allSystemsById, $userSettings } from "@/lib/stores"
import { cn, decimalString, formatBytes, toFixedFloat } from "@/lib/utils"
import type { ContainerStats } from "@/types"
import { t } from "@lingui/core/macro"
import { useStore } from "@nanostores/react"
import type { Column, ColumnDef } from "@tanstack/react-table"
import {
	ArrowUpDownIcon,
	ContainerIcon,
	CpuIcon,
	MemoryStickIcon,
	NetworkIcon,
	ServerIcon,
} from "lucide-react"

export interface ContainerTableRow extends ContainerStats {
	system?: string
}

function HeaderButton<T>({
	column,
	name,
	Icon,
}: { column: Column<T>; name: string; Icon: React.ElementType }) {
	const isSorted = column.getIsSorted()
	return (
		<Button
			className={cn(
				"h-9 px-3 flex items-center gap-2 duration-50",
				isSorted && "bg-accent/70 light:bg-accent text-accent-foreground/90"
			)}
			variant="ghost"
			onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
		>
			{Icon && <Icon className="size-4" />}
			{name}
			<ArrowUpDownIcon className="size-4" />
		</Button>
	)
}

export const containersTableColumns: ColumnDef<ContainerTableRow>[] = [
	{
		id: "name",
		accessorFn: (record) => record.n,
		header: ({ column }) => <HeaderButton column={column} name={t`Name`} Icon={ContainerIcon} />,
		cell: ({ getValue }) => {
			const name = getValue() as string
			return (
				<div className="flex items-center gap-2 ms-1.5 font-medium">
					<ContainerIcon className="size-4 text-muted-foreground shrink-0" />
					<span className="truncate max-w-[200px] sm:max-w-[300px]">{name}</span>
				</div>
			)
		},
	},
	{
		id: "system",
		accessorFn: (record) => record.system ?? "",
		header: ({ column }) => <HeaderButton column={column} name={t`System`} Icon={ServerIcon} />,
		cell: ({ getValue }) => {
			const systemId = getValue() as string
			const allSystems = useStore($allSystemsById)
			if (!systemId) return null
			const systemName = allSystems[systemId]?.name ?? systemId
			return (
				<span className="ms-1.5 truncate max-w-[150px] inline-block text-muted-foreground">{systemName}</span>
			)
		},
	},
	{
		id: "cpu",
		accessorFn: (record) => record.c,
		invertSorting: true,
		header: ({ column }) => <HeaderButton column={column} name={t`CPU`} Icon={CpuIcon} />,
		cell: ({ getValue }) => {
			const val = getValue() as number
			return (
				<div className="flex items-center gap-2 ms-1.5">
					<span className="tabular-nums min-w-[3.5rem]">{`${toFixedFloat(val, 1)}%`}</span>
					<div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden hidden sm:block">
						<div
							className="h-full bg-primary transition-all duration-300 rounded-full"
							style={{ width: `${Math.min(Math.max(val, 0), 100)}%` }}
						/>
					</div>
				</div>
			)
		},
	},
	{
		id: "memory",
		accessorFn: (record) => record.m,
		invertSorting: true,
		header: ({ column }) => <HeaderButton column={column} name={t`Memory`} Icon={MemoryStickIcon} />,
		cell: ({ getValue }) => {
			const val = getValue() as number
			const formatted = formatBytes(val, false, Unit.Bytes, true)
			return (
				<span className="ms-1.5 tabular-nums">
					{`${decimalString(formatted.value, formatted.value >= 10 ? 1 : 2)} ${formatted.unit}`}
				</span>
			)
		},
	},
	{
		id: "network",
		accessorFn: (record) => {
			if (record.b) return record.b[0] + record.b[1]
			return (record.ns ?? 0) + (record.nr ?? 0)
		},
		invertSorting: true,
		header: ({ column }) => <HeaderButton column={column} name={t`Net`} Icon={NetworkIcon} />,
		cell: ({ row }) => {
			const record = row.original
			const userSettings = useStore($userSettings, { keys: ["unitNet"] })
			const tx = record.b ? record.b[0] : (record.ns ?? 0)
			const rx = record.b ? record.b[1] : (record.nr ?? 0)
			const rxFormatted = formatBytes(rx, true, userSettings.unitNet, false)
			const txFormatted = formatBytes(tx, true, userSettings.unitNet, false)
			return (
				<span className="ms-1.5 tabular-nums text-xs sm:text-sm whitespace-nowrap">
					<span className="text-muted-foreground font-mono">↓</span>{" "}
					{`${decimalString(rxFormatted.value, rxFormatted.value >= 100 ? 1 : 2)} ${rxFormatted.unit}`}{" "}
					<span className="text-muted-foreground font-mono ms-1">↑</span>{" "}
					{`${decimalString(txFormatted.value, txFormatted.value >= 100 ? 1 : 2)} ${txFormatted.unit}`}
				</span>
			)
		},
	},
]
