import type {
	BatteryState,
	ConnectionType,
	HourFormat,
	Os,
	ServiceStatus,
	ServiceSubState,
	Unit,
} from "@/lib/enums"

// global window properties
declare global {
	var BESZEL: {
		BASE_PATH: string
		HUB_VERSION: string
		HUB_URL: string
		OAUTH_DISABLE_POPUP: boolean
	}
}

/** Base record — menggantikan PocketBase RecordModel */
export interface BaseRecord {
	id: string
	created?: string | number
	updated?: string | number
}

export interface SystemRecord extends BaseRecord {
	name: string
	host: string
	status: "up" | "down" | "unknown" | "paused" | "pending"
	port?: string
	info: SystemInfo
	v?: string
	updated?: string
	last_seen?: number | null
	timeout_seconds?: number
}

export interface SystemInfo {
	/** hostname */
	h?: string
	/** kernel **/
	k?: string
	/** cpu percent */
	cpu?: number
	/** cpu threads */
	t?: number
	/** cpu cores */
	c?: number
	/** cpu model */
	m?: string
	/** load average */
	la?: [number, number, number]
	/** operating system */
	o?: string
	/** uptime */
	u?: number
	/** memory percent */
	mp?: number
	/** disk percent */
	dp?: number
	/** battery percent and state */
	bat?: [number, BatteryState]
	/** bandwidth (mb) */
	b?: number
	/** bandwidth bytes */
	bb?: number
	/** agent version */
	v?: string
	/** system is using podman */
	p?: boolean
	/** highest gpu utilization */
	g?: number
	/** dashboard display temperature */
	dt?: number
	/** operating system */
	os?: Os
	/** connection type */
	ct?: ConnectionType
	/** extra filesystem percentages */
	efs?: Record<string, number>
	/** services [totalServices, numFailedServices] */
	sv?: [number, number]
}

export interface SystemStats {
	cpu?: number
	cpum?: number
	cpub?: number[]
	cpus?: number[]
	la?: [number, number, number]
	m?: number
	mu?: number
	mp?: number
	mb?: number
	mm?: number
	mz?: number
	s?: number
	su?: number
	d?: number
	du?: number
	dp?: number
	dr?: number
	dw?: number
	drm?: number
	dwm?: number
	dio?: [number, number]
	diom?: [number, number]
	dios?: [number, number, number, number, number, number]
	diosm?: [number, number, number, number, number, number]
	ns?: number
	nr?: number
	b?: [number, number]
	nsm?: number
	nrm?: number
	bm?: [number, number]
	t?: Record<string, number>
	efs?: Record<string, ExtraFsStats>
	g?: Record<string, GPUData>
	bat?: [number, BatteryState]
	ni?: Record<string, [number, number, number, number]>
}

export interface GPUData {
	n: string
	mu?: number
	mt?: number
	u: number
	p?: number
	pp?: number
	e?: Record<string, number>
}

export interface ExtraFsStats {
	d: number
	du: number
	r: number
	w: number
	rm: number
	wm: number
	rb: number
	wb: number
	rbm: number
	wbm: number
	dios?: [number, number, number, number, number, number]
	diosm?: [number, number, number, number, number, number]
}

export interface ContainerStatsRecord extends BaseRecord {
	system: string
	stats: ContainerStats[]
	created: string | number
}

interface ContainerStats {
	n: string
	c: number
	m: number
	ns?: number
	nr?: number
	b?: [number, number]
}

export interface SystemStatsRecord extends BaseRecord {
	system: string
	stats: SystemStats
	created: string | number
}

export interface AlertRecord extends BaseRecord {
	id: string
	system: string
	name: string
	triggered: boolean
	value: number
	min: number
}

export interface AlertsHistoryRecord extends BaseRecord {
	alert: string
	user: string
	system: string
	name: string
	val: number
	created: string
	resolved?: string | null
}

export interface QuietHoursRecord extends BaseRecord {
	id: string
	user: string
	system: string
	type: "one-time" | "daily"
	start: string
	end: string
	expand?: {
		system?: { name: string }
	}
}

export interface ContainerRecord extends BaseRecord {
	id: string
	system: string
	name: string
	image: string
	ports: string
	cpu: number
	memory: number
	net: number
	health: number
	status: string
	updated: number
}

export type ChartTimes = "1m" | "1h" | "12h" | "24h" | "1w" | "30d"

export interface ChartTimeData {
	[key: string]: {
		type: "1m" | "10m" | "20m" | "120m" | "480m"
		expectedInterval: number
		label: () => string
		ticks?: number
		format: (timestamp: string) => string
		getOffset: (endTime: Date) => Date
		minVersion?: string
	}
}

export interface UserSettings {
	chartTime: ChartTimes
	emails?: string[]
	webhooks?: string[]
	unitTemp?: Unit
	unitNet?: Unit
	unitDisk?: Unit
	colorWarn?: number
	colorCrit?: number
	hourFormat?: HourFormat
	layoutWidth?: number
}

type ChartDataContainer = {
	created: number | null
} & {
	[key: string]: key extends "created" ? never : ContainerStats
}

export interface SemVer {
	major: number
	minor: number
	patch: number
}

export interface ChartData {
	agentVersion: SemVer
	systemStats: SystemStatsRecord[]
	containerData: ChartDataContainer[]
	orientation: "right" | "left"
	ticks: number[]
	domain: number[]
	chartTime: ChartTimes
}

export interface AlertInfo {
	name: () => string
	unit: string
	icon: React.ComponentType<{ className?: string }>
	desc: () => string
	max?: number
	min?: number
	step?: number
	start?: number
	singleDesc?: () => string
	invert?: boolean
}

export type AlertMap = Record<string, Map<string, AlertRecord>>

export interface SmartData {
	mn?: string
	sn?: string
	fv?: string
	c?: number
	s?: string
	dn?: string
	dt?: string
	t?: number
	a?: SmartAttribute[]
}

export interface SmartAttribute {
	id?: number
	n: string
	v: number
	w?: number
	t?: number
	rv?: number
	rs?: string
	wf?: string
}

export interface SystemDetailsRecord extends BaseRecord {
	system: string
	hostname: string
	kernel: string
	cores: number
	threads: number
	cpu: string
	arch?: string
	os: Os
	os_name: string
	memory: number
	podman: boolean
}

export interface SmartDeviceRecord extends BaseRecord {
	id: string
	system: string
	name: string
	model: string
	state: string
	capacity: number
	temp: number
	firmware: string
	serial: string
	type: string
	hours: number
	cycles: number
	attributes: SmartAttribute[]
	updated: string
}

export interface SystemdRecord extends BaseRecord {
	system: string
	name: string
	state: ServiceStatus
	sub: ServiceSubState
	cpu: number
	cpuPeak: number
	memory: number
	memPeak: number
	updated: number
}

export interface BeszelInfo {
	key: string
	v: string
	cu: boolean
}

export interface UpdateInfo {
	v: string
	url: string
}

export interface FingerprintRecord extends BaseRecord {
	id: string
	system: string
	fingerprint: string
	token: string
	expand?: {
		system?: { name: string }
	}
}
