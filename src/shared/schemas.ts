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
