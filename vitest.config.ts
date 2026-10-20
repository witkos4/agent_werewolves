import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // workers/app.ts imports the React Router build, which only the React
      // Router Vite plugin resolves; tests use a slim entry with the same DO.
      main: "./test/worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OPENROUTER_API_KEY: "test-openrouter-key",
          SPIKE_KEY: "test-spike-key",
        },
      },
    }),
  ],
  test: {
    // Hibernatable WebSockets with Durable Objects need a single shared worker.
    maxWorkers: 1,
    isolate: false,
  },
});
