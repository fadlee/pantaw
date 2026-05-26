import path from "node:path"
import { cloudflare } from "@cloudflare/vite-plugin"
import { lingui } from "@lingui/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		react({
			plugins: [["@lingui/swc-plugin", {}]],
		}),
		lingui(),
		tailwindcss(),
		cloudflare({
			configPath: "./wrangler.toml",
		}),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src/client"),
			"@/server": path.resolve(__dirname, "./src/server"),
			"@/shared": path.resolve(__dirname, "./src/shared"),
		},
	},
})
