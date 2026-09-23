import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ContainerStatsRecord } from "@/types"
import { Trans, useLingui } from "@lingui/react/macro"
import {
	type ColumnFiltersState,
	type SortingState,
	type VisibilityState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	useReactTable,
} from "@tanstack/react-table"
import { ContainerIcon, SearchIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { cache } from "../routes/system/chart-data"
import { type ContainerTableRow, containersTableColumns } from "./containers-table-columns"

export default function ContainersTable({
	systemId,
	data,
	showSystemColumn = false,
}: {
	systemId?: string
	data?: ContainerTableRow[]
	showSystemColumn?: boolean
}) {
	const { t } = useLingui()
	const [filter, setFilter] = useState("")
	const [sorting, setSorting] = useState<SortingState>([{ id: "cpu", desc: true }])
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({
		system: showSystemColumn,
	})

	const tableData = useMemo<ContainerTableRow[]>(() => {
		if (data) return data
		if (!systemId) return []
		for (const [key, val] of cache.entries()) {
			if (key.startsWith(`${systemId}_`) && key.endsWith("_container_stats") && Array.isArray(val)) {
				const lastRecord = val.at(-1) as ContainerStatsRecord | undefined
				if (lastRecord && Array.isArray(lastRecord.stats)) {
					return lastRecord.stats.map((s) => ({ ...s, system: systemId }))
				}
			}
		}
		return []
	}, [data, systemId])

	const table = useReactTable({
		data: tableData,
		columns: containersTableColumns,
		state: {
			sorting,
			columnFilters,
			columnVisibility,
			globalFilter: filter,
		},
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		onColumnVisibilityChange: setColumnVisibility,
		onGlobalFilterChange: setFilter,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	})

	return (
		<Card className="mt-4">
			<CardHeader className="pb-3">
				<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
					<div>
						<CardTitle className="text-base font-semibold flex items-center gap-2">
							<ContainerIcon className="size-4 text-muted-foreground" />
							<Trans>Containers</Trans>
							<span className="text-xs font-normal text-muted-foreground">({tableData.length})</span>
						</CardTitle>
						<CardDescription className="text-xs">
							<Trans>Real-time resource utilization by container</Trans>
						</CardDescription>
					</div>
					<div className="relative w-full sm:w-64">
						<SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
						<Input
							placeholder={t`Search containers...`}
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							className="pl-8 h-9 text-xs"
						/>
					</div>
				</div>
			</CardHeader>
			<CardContent className="p-0">
				<Table>
					<TableHeader>
						{table.getHeaderGroups().map((headerGroup) => (
							<TableRow key={headerGroup.id}>
								{headerGroup.headers.map((header) => (
									<TableHead key={header.id} className="py-2">
										{header.isPlaceholder
											? null
											: flexRender(header.column.columnDef.header, header.getContext())}
									</TableHead>
								))}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{table.getRowModel().rows.length ? (
							table.getRowModel().rows.map((row) => (
								<TableRow key={row.id}>
									{row.getVisibleCells().map((cell) => (
										<TableCell key={cell.id} className="py-2.5">
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</TableCell>
									))}
								</TableRow>
							))
						) : (
							<TableRow>
								<TableCell colSpan={containersTableColumns.length} className="h-24 text-center text-muted-foreground">
									<Trans>No containers found</Trans>
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	)
}
