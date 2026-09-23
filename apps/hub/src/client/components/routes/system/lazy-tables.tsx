import { useIntersectionObserver } from "@/lib/use-intersection-observer"
import { cn } from "@/lib/utils"
import { lazy } from "react"
import type { ContainerTableRow } from "../../containers-table/containers-table-columns"

const ContainersTable = lazy(() => import("../../containers-table/containers-table"))

export function LazyContainersTable({ data }: { data: ContainerTableRow[] }) {
	const { isIntersecting, ref } = useIntersectionObserver({ rootMargin: "90px" })
	return (
		<div ref={ref} className={cn(isIntersecting && "contents")}>
			{isIntersecting && <ContainersTable data={data} />}
		</div>
	)
}

const SystemdTable = lazy(() => import("../../systemd-table/systemd-table"))

export function LazySystemdTable({ systemId }: { systemId: string }) {
	const { isIntersecting, ref } = useIntersectionObserver()
	return (
		<div ref={ref} className={cn(isIntersecting && "contents")}>
			{isIntersecting && <SystemdTable systemId={systemId} />}
		</div>
	)
}
