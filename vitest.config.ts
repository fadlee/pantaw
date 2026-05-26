import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig(async () => {
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
						},
					},
				},
			},
		},
	}
})
