import { Database } from "bun:sqlite"
import { globSync } from "node:fs"

// Find local sqlite file
const sqliteFiles = globSync(".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite")
if (sqliteFiles.length === 0) {
	console.error("No miniflare sqlite database found in .wrangler!")
	process.exit(1)
}

const dbPath = sqliteFiles[0]
console.log(`Using database: ${dbPath}`)
const db = new Database(dbPath)

async function sha256Hex(str: string): Promise<string> {
	const data = new TextEncoder().encode(str)
	const buf = await crypto.subtle.digest("SHA-256", data)
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
}

interface MockSystem {
	id: string
	name: string
	host: string
	token: string
	info: Record<string, unknown>
	containers: Array<{ name: string; baseCpu: number; baseMem: number }>
}

const MOCK_SYSTEMS: MockSystem[] = [
	{
		id: "sys_prod_01",
		name: "production-vps-01",
		host: "192.168.1.10:45876",
		token: "pantaw_agent_prod01_secret_token_12345",
		info: {
			m: "AMD EPYC 7763 64-Core",
			c: 8,
			t: 16 * 1024 * 1024 * 1024, // 16 GB
			d: 500 * 1024 * 1024 * 1024, // 500 GB
			os: "linux",
			h: "prod-vps-01",
			v: "0.15.0",
		},
		containers: [
			{ name: "nginx-proxy", baseCpu: 2.1, baseMem: 85 },
			{ name: "api-gateway", baseCpu: 6.4, baseMem: 340 },
			{ name: "postgres-main", baseCpu: 11.2, baseMem: 1420 },
			{ name: "redis-cache", baseCpu: 1.8, baseMem: 260 },
			{ name: "worker-queue", baseCpu: 8.5, baseMem: 512 },
		],
	},
	{
		id: "sys_db_02",
		name: "database-cluster-02",
		host: "192.168.1.20:45876",
		token: "pantaw_agent_db02_secret_token_67890",
		info: {
			m: "Intel Xeon Platinum 8375C",
			c: 16,
			t: 32 * 1024 * 1024 * 1024, // 32 GB
			d: 1000 * 1024 * 1024 * 1024, // 1 TB
			os: "linux",
			h: "db-node-02",
			v: "0.15.0",
		},
		containers: [
			{ name: "postgres-replica", baseCpu: 9.3, baseMem: 2100 },
			{ name: "clickhouse-analytics", baseCpu: 14.7, baseMem: 3800 },
			{ name: "pg-backup-runner", baseCpu: 0.5, baseMem: 110 },
		],
	},
	{
		id: "sys_edge_03",
		name: "edge-worker-singapore",
		host: "192.168.1.30:45876",
		token: "pantaw_agent_edge03_secret_token_11223",
		info: {
			m: "Apple M2 Pro",
			c: 10,
			t: 16 * 1024 * 1024 * 1024,
			d: 256 * 1024 * 1024 * 1024,
			os: "darwin",
			h: "edge-sg-01",
			v: "0.15.0",
		},
		containers: [
			{ name: "caddy-ssl", baseCpu: 1.2, baseMem: 45 },
			{ name: "edge-tunnel", baseCpu: 3.1, baseMem: 128 },
		],
	},
]

async function setupSystems() {
	const now = Math.floor(Date.now() / 1000)

	for (const sys of MOCK_SYSTEMS) {
		const tokenHash = await sha256Hex(sys.token)
		const infoJson = JSON.stringify(sys.info)

		// Upsert system
		db.run(
			`INSERT INTO systems (id, name, host, agent_token_hash, timeout_seconds, last_status, last_status_at, created_at, updated_at, info)
			 VALUES (?, ?, ?, ?, 90, 'up', ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   host = excluded.host,
			   agent_token_hash = excluded.agent_token_hash,
			   last_status = 'up',
			   last_status_at = excluded.last_status_at,
			   updated_at = excluded.updated_at,
			   info = excluded.info`,
			[sys.id, sys.name, sys.host, tokenHash, now, now, now, infoJson]
		)

		// Upsert agent token
		db.run(
			`INSERT OR IGNORE INTO agent_tokens (id, system_id, token_hash, label, created_at)
			 VALUES (?, ?, ?, 'mock-token', ?)`,
			[`token_${sys.id}`, sys.id, tokenHash, now]
		)
	}
	console.log(`✓ Seeded ${MOCK_SYSTEMS.length} systems and tokens`)
}

function generateMetricsForTime(sys: MockSystem, ts: number, stepIndex: number) {
	const phase = (stepIndex * 0.1) % (Math.PI * 2)
	const noise = () => (Math.random() - 0.5) * 4

	const cpu = Math.max(5, Math.min(95, 25 + Math.sin(phase) * 15 + noise()))
	const memPct = Math.max(20, Math.min(85, 45 + Math.cos(phase * 0.7) * 10 + noise()))
	const totalMemBytes = (sys.info.t as number) || 16 * 1024 * 1024 * 1024
	const memUsedBytes = Math.floor((memPct / 100) * totalMemBytes)
	const disk = 52.4 + Math.sin(phase * 0.05) * 1.5

	const diskRead = Math.max(0, Math.floor(1024 * 1024 * (5 + Math.sin(phase * 2) * 4 + noise())))
	const diskWrite = Math.max(0, Math.floor(1024 * 1024 * (8 + Math.cos(phase * 2) * 6 + noise())))

	const netRx = Math.max(0, Math.floor(1024 * 1024 * (12 + Math.sin(phase * 1.5) * 8 + noise())))
	const netTx = Math.max(0, Math.floor(1024 * 1024 * (18 + Math.cos(phase * 1.5) * 10 + noise())))

	const load1 = Number((cpu / 20 + Math.random() * 0.3).toFixed(2))
	const load5 = Number((load1 * 0.95).toFixed(2))
	const load15 = Number((load1 * 0.9).toFixed(2))

	const temp = Math.floor(45 + (cpu / 100) * 20 + (Math.random() - 0.5) * 2)

	// Container stats
	const containers = sys.containers.map((c) => {
		const cNoise = (Math.random() - 0.5) * 2
		const cCpu = Number(
			Math.max(0.1, c.baseCpu + Math.sin(phase + c.name.length) * (c.baseCpu * 0.4) + cNoise).toFixed(1)
		)
		const cMem = Math.max(10, Math.floor(c.baseMem + Math.cos(phase) * 15))
		const cNetRx = Math.floor(1024 * 1024 * (0.5 + Math.random() * 2))
		const cNetTx = Math.floor(1024 * 1024 * (1.0 + Math.random() * 3))
		return {
			name: c.name,
			cpu: cCpu,
			mem: cMem,
			net_rx: cNetRx,
			net_tx: cNetTx,
		}
	})

	return {
		ts,
		cpu: Number(cpu.toFixed(1)),
		mem: Number(memPct.toFixed(1)),
		mem_used: memUsedBytes,
		mem_total: totalMemBytes,
		disk: Number(disk.toFixed(1)),
		disk_read: diskRead,
		disk_write: diskWrite,
		net_rx: netRx,
		net_tx: netTx,
		load: [load1, load5, load15] as [number, number, number],
		temp,
		containers,
	}
}

async function seedHistory() {
	console.log("Resetting and seeding past 1 hour of historical metrics...")
	db.run("DELETE FROM metrics")
	const now = Math.floor(Date.now() / 1000)
	const interval = 15 // 15 seconds per point
	const pointsCount = 240 // 1 hour = 240 points
	const startTs = now - pointsCount * interval
	const insertStmt = db.prepare(
		`INSERT OR IGNORE INTO metrics
		 (system_id, ts, cpu, mem, mem_used, mem_total, disk, disk_read, disk_write,
		  net_rx, net_tx, load1, load5, load15, temp, extra)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)

	interface DbRow {
		system_id: string
		ts: number
		cpu: number
		mem: number
		mem_used: number
		mem_total: number
		disk: number
		disk_read: number
		disk_write: number
		net_rx: number
		net_tx: number
		load1: number
		load5: number
		load15: number
		temp: number
		extra: string
	}

	const insertMany = db.transaction((rows: DbRow[]) => {
		for (const r of rows) {
			insertStmt.run(
				r.system_id,
				r.ts,
				r.cpu,
				r.mem,
				r.mem_used,
				r.mem_total,
				r.disk,
				r.disk_read,
				r.disk_write,
				r.net_rx,
				r.net_tx,
				r.load1,
				r.load5,
				r.load15,
				r.temp,
				r.extra
			)
		}
	})

	for (const sys of MOCK_SYSTEMS) {
		const rows = []
		for (let i = 0; i < pointsCount; i++) {
			const ts = startTs + i * interval
			const m = generateMetricsForTime(sys, ts, i)
			const extra = JSON.stringify({ containers: m.containers })
			rows.push({
				system_id: sys.id,
				ts: m.ts,
				cpu: m.cpu,
				mem: m.mem,
				mem_used: m.mem_used,
				mem_total: m.mem_total,
				disk: m.disk,
				disk_read: m.disk_read,
				disk_write: m.disk_write,
				net_rx: m.net_rx,
				net_tx: m.net_tx,
				load1: m.load[0],
				load5: m.load[1],
				load15: m.load[2],
				temp: m.temp,
				extra,
			})
		}
		insertMany(rows)
		console.log(`✓ Seeded ${rows.length} points for ${sys.name}`)
	}
}

async function startAgentStream(targetUrl = "http://localhost:5173/api/v1/ingest") {
	console.log(`\n🚀 Starting live agent metric stream to ${targetUrl}`)
	console.log("Press Ctrl+C to stop.\n")

	let step = 0
	setInterval(async () => {
		step++
		const now = Math.floor(Date.now() / 1000)

		for (const sys of MOCK_SYSTEMS) {
			const metric = generateMetricsForTime(sys, now, step)
			try {
				const res = await fetch(targetUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${sys.token}`,
					},
					body: JSON.stringify(metric),
				})

				if (res.status === 204 || res.status === 200) {
					console.log(
						`[${new Date().toLocaleTimeString()}] ${sys.name.padEnd(22)} | CPU: ${metric.cpu.toString().padStart(4)}% | MEM: ${metric.mem.toString().padStart(4)}% | Containers: ${metric.containers.length} | Ingest OK`
					)
				} else {
					const text = await res.text()
					console.error(`[${new Date().toLocaleTimeString()}] ${sys.name} -> Ingest failed (${res.status}):`, text)
				}
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err)
				console.error(`[${new Date().toLocaleTimeString()}] ${sys.name} -> Fetch error:`, message)
			}
		}
	}, 3000)
}

async function main() {
	await setupSystems()
	await seedHistory()
	if (!process.argv.includes("--seed-only")) {
		await startAgentStream()
	}
}
main().catch(console.error)
