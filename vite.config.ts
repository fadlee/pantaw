import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
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
	build: {
		outDir: "dist",
	},
})
