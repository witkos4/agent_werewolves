import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Applied to the local ARCHIVE database in test/setup.ts.
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        // workers/app.ts imports the React Router build, which only the React
        // Router Vite plugin resolves; tests use a slim entry with the same DO.
        main: "./test/worker.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            OPENROUTER_API_KEY: "test-openrouter-key",
            ACCESS_KEY: "test-access-key-0123456789abcdefghij",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    // Route modules import `~/…` (tsconfig paths), as in vite.config.ts.
    resolve: {
      tsconfigPaths: true,
    },
    test: {
      setupFiles: ["./test/setup.ts"],
      // Hibernatable WebSockets with Durable Objects need a single shared worker.
      maxWorkers: 1,
      isolate: false,
    },
  };
});
