import { cloudflare } from "@cloudflare/vite-plugin"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		cloudflare({
			configPath: "./wrangler.toml",
		}),
	],
	resolve: {
		alias: {
			"@/server": "/src/server",
			"@/client": "/src/client",
			"@/shared": "/src/shared",
		},
	},
})
