/** Operating system */
export enum Os {
	Linux = 0,
	Darwin = 1,
	Windows = 2,
	FreeBSD = 3,
}

/** Type of chart */
export enum ChartType {
	Memory = 0,
	Disk = 1,
	Network = 2,
	CPU = 3,
}

/** Unit of measurement */
export enum Unit {
	Bytes = 0,
	Bits = 1,
	Celsius = 2,
	Fahrenheit = 3,
}

/** Meter state for color */
export enum MeterState {
	Good = 0,
	Warn = 1,
	Crit = 2,
}

/** System status states */
export enum SystemStatus {
	Up = "up",
	Down = "down",
	Pending = "pending",
	Paused = "paused",
}

/** Battery state */
export enum BatteryState {
	Unknown = 0,
	Empty = 1,
	Full = 2,
	Charging = 3,
	Discharging = 4,
	Idle = 5,
}

/** Time format */
export enum HourFormat {
	// Default = "Default",
	"12h" = "12h",
	"24h" = "24h",
}

/** Container health status */
export enum ContainerHealth {
	None = 0,
	Starting = 1,
	Healthy = 2,
	Unhealthy = 3,
}

export const ContainerHealthLabels = ["None", "Starting", "Healthy", "Unhealthy"] as const

/** Connection type */
export enum ConnectionType {
	SSH = 1,
	WebSocket = 2,
}

export const connectionTypeLabels = ["", "SSH", "WebSocket"] as const

/** Systemd service state */
export enum ServiceStatus {
	Active = 0,
	Inactive = 1,
	Failed = 2,
	Activating = 3,
	Deactivating = 4,
	Reloading = 5,
}

export const ServiceStatusLabels = [
	"Active",
	"Inactive",
	"Failed",
	"Activating",
	"Deactivating",
	"Reloading",
] as const

/** Systemd service sub state */
export enum ServiceSubState {
	Dead = 0,
	Running = 1,
	Exited = 2,
	Failed = 3,
	Unknown = 4,
}

export const ServiceSubStateLabels = ["Dead", "Running", "Exited", "Failed", "Unknown"] as const
