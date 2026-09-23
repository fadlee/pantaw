/**
 * Auto-migration / schema initialization for Cloudflare D1.
 * Ensures all required tables and indexes exist on cold start.
 */

let initialized = false
let initPromise: Promise<void> | null = null

export const INITIAL_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS systems (
		id              TEXT PRIMARY KEY,
		name            TEXT NOT NULL UNIQUE,
		host            TEXT NOT NULL,
		agent_token_hash TEXT NOT NULL,
		timeout_seconds INTEGER NOT NULL DEFAULT 90,
		last_status     TEXT NOT NULL DEFAULT 'unknown',
		last_status_at  INTEGER,
		created_at      INTEGER NOT NULL,
		updated_at      INTEGER NOT NULL,
		info            TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS users (
		id              TEXT PRIMARY KEY,
		email           TEXT NOT NULL UNIQUE,
		password_hash   TEXT NOT NULL,
		role            TEXT NOT NULL DEFAULT 'user',
		created_at      INTEGER NOT NULL,
		system_ids      TEXT NOT NULL DEFAULT '[]'
	)`,
	`CREATE TABLE IF NOT EXISTS metrics (
		system_id  TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
		ts         INTEGER NOT NULL,
		cpu        REAL,
		mem        REAL,
		mem_used   INTEGER,
		mem_total  INTEGER,
		disk       REAL,
		disk_read  INTEGER,
		disk_write INTEGER,
		net_rx     INTEGER,
		net_tx     INTEGER,
		load1      REAL,
		load5      REAL,
		load15     REAL,
		temp       REAL,
		extra      TEXT,
		PRIMARY KEY (system_id, ts)
	) WITHOUT ROWID`,
	`CREATE TABLE IF NOT EXISTS alerts (
		id           TEXT PRIMARY KEY,
		system_id    TEXT REFERENCES systems(id) ON DELETE CASCADE,
		metric       TEXT NOT NULL,
		threshold    REAL NOT NULL,
		operator     TEXT NOT NULL,
		duration_s   INTEGER NOT NULL DEFAULT 60,
		enabled      INTEGER NOT NULL DEFAULT 1,
		webhook_url  TEXT,
		last_fired   INTEGER
	)`,
	"CREATE INDEX IF NOT EXISTS idx_alerts_system ON alerts (system_id)",
	`CREATE TABLE IF NOT EXISTS agent_tokens (
		id          TEXT PRIMARY KEY,
		system_id   TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
		token_hash  TEXT NOT NULL UNIQUE,
		label       TEXT,
		created_at  INTEGER NOT NULL,
		last_used   INTEGER
	)`,
	"CREATE INDEX IF NOT EXISTS idx_agent_tokens_system ON agent_tokens (system_id)",
]

export async function ensureSchema(db: D1Database): Promise<void> {
	if (initialized) return

	if (!initPromise) {
		initPromise = (async () => {
			const statements = INITIAL_SCHEMA.map((sql) => db.prepare(sql))
			await db.batch(statements)
			initialized = true
		})().catch((err) => {
			initPromise = null
			throw err
		})
	}

	await initPromise
}

/** Reset in-memory initialization state (useful for test suites) */
export function resetSchemaState(): void {
	initialized = false
	initPromise = null
}
