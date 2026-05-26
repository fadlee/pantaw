/// <reference types="@cloudflare/vitest-pool-workers" />

import type { Env } from "../src/server/index"

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		MIGRATIONS: D1Migration[]
	}
}
