import { mkdir } from "node:fs/promises"
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig(async () => {
	// wrangler.toml menunjuk [assets] ke ./dist/client dan wrangler menolak jalan
	// jika folder itu tidak ada. Tes tidak butuh isinya, jadi cukup pastikan
	// foldernya ada agar test bisa jalan di clone baru / CI tanpa build dulu.
	await mkdir("./dist/client", { recursive: true })
	const migrations = await readD1Migrations("./migrations")
	return {
		test: {
			setupFiles: ["./tests/apply-migrations.ts"],
			poolOptions: {
				workers: {
					singleWorker: true,
					wrangler: { configPath: "./wrangler.toml" },
					miniflare: {
						bindings: {
							MIGRATIONS: migrations,
							JWT_SECRET_V1: "test-secret-v1-very-long-random-value-for-tests",
							JWT_KID_CURRENT: "v1",
						},
					},
				},
			},
		},
	}
})
