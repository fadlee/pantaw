import * as v from "valibot"

/**
 * Container stats per item (Docker-like).
 */
export const ContainerStatsSchema = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
	cpu: v.optional(v.number()),
	mem: v.optional(v.number()),
	net_rx: v.optional(v.number()),
	net_tx: v.optional(v.number()),
})

export type ContainerStats = v.InferOutput<typeof ContainerStatsSchema>

/**
 * Payload metrik tunggal yang dikirim agent ke /api/v1/ingest.
 *
 * `ts` adalah unix timestamp (detik). Validasi window (clock skew) dilakukan
 * di server, bukan di schema, supaya pesan errornya jelas.
 *
 * Catatan: ekstra field di luar yang dideklarasikan akan dipindah ke kolom
 * `extra` (JSON) di tabel metrics. Lihat ingest route.
 */
export const MetricsPayloadSchema = v.object({
	ts: v.pipe(v.number(), v.integer(), v.minValue(0)),
	cpu: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100))),
	mem: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100))),
	mem_used: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	mem_total: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	disk: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100))),
	disk_read: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	disk_write: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	net_rx: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	net_tx: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	load: v.optional(v.pipe(v.array(v.number()), v.length(3))),
	temp: v.optional(v.number()),
	uptime: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	containers: v.optional(v.array(ContainerStatsSchema)),
})

export type MetricsPayload = v.InferOutput<typeof MetricsPayloadSchema>

/**
 * Body /api/v1/ingest menerima single object atau array of objects.
 * Array dipakai untuk batching (durable buffer post-MVP).
 */
export const IngestBodySchema = v.union([MetricsPayloadSchema, v.array(MetricsPayloadSchema)])

export type IngestBody = v.InferOutput<typeof IngestBodySchema>

/**
 * Login request body.
 */
export const LoginBodySchema = v.object({
	email: v.pipe(v.string(), v.email(), v.maxLength(255)),
	password: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
})

export type LoginBody = v.InferOutput<typeof LoginBodySchema>

/**
 * Body untuk first-time setup (register admin pertama).
 * Endpoint hanya bisa dipakai saat tabel users masih kosong.
 */
export const SetupBodySchema = v.object({
	email: v.pipe(v.string(), v.email(), v.maxLength(255)),
	password: v.pipe(v.string(), v.minLength(8), v.maxLength(1024)),
})

export type SetupBody = v.InferOutput<typeof SetupBodySchema>

/**
 * Body untuk membuat system baru.
 */
export const CreateSystemBodySchema = v.object({
	name: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
	host: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
	timeout_seconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(3600))),
})

export type CreateSystemBody = v.InferOutput<typeof CreateSystemBodySchema>

/**
 * Query parameter untuk GET /api/v1/systems/:id/metrics.
 *
 * - `from`, `to`: unix timestamp (detik), default = 1 jam terakhir
 * - `bucket`: optional, agregasi ke bucket N detik (mis. 60 = per menit).
 *   Tanpa bucket = raw rows. Dengan bucket = AVG per bucket.
 * - `limit`: cap jumlah row, default 500, max 5000
 */
export const MetricsQuerySchema = v.object({
	from: v.optional(v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0))),
	to: v.optional(v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0))),
	bucket: v.optional(
		v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(30), v.maxValue(86_400))
	),
	limit: v.optional(
		v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1), v.maxValue(5000))
	),
})

export type MetricsQuery = v.InferOutput<typeof MetricsQuerySchema>

/**
 * Body untuk membuat / update alert.
 *
 * - `metric`: kolom yang dievaluasi (cpu | mem | disk | temp | status)
 * - `operator`: gt | lt | eq
 * - `threshold`: nilai ambang batas; untuk `status`, 1 = up, 0 = down
 * - `duration_s`: kondisi harus terpenuhi selama N detik baru fire
 * - `webhook_url`: URL POST notifikasi (optional)
 */
const alertMetric = v.picklist(["cpu", "mem", "disk", "temp", "status"])
const alertOperator = v.picklist(["gt", "lt", "eq"])

export const CreateAlertBodySchema = v.object({
	system_id: v.pipe(v.string(), v.minLength(1)),
	metric: alertMetric,
	operator: alertOperator,
	threshold: v.number(),
	duration_s: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400))),
	enabled: v.optional(v.boolean()),
	webhook_url: v.optional(v.pipe(v.string(), v.url(), v.maxLength(2048))),
})

export type CreateAlertBody = v.InferOutput<typeof CreateAlertBodySchema>

export const UpdateAlertBodySchema = v.partial(
	v.object({
		metric: alertMetric,
		operator: alertOperator,
		threshold: v.number(),
		duration_s: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400)),
		enabled: v.boolean(),
		webhook_url: v.union([v.pipe(v.string(), v.url(), v.maxLength(2048)), v.null()]),
	})
)

export type UpdateAlertBody = v.InferOutput<typeof UpdateAlertBodySchema>
