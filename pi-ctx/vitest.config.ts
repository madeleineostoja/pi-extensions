import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			typebox: resolve(
				__dirname,
				"node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs",
			),
		},
	},
	test: {
		globals: false,
	},
});
