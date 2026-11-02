import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

// Idempotent: records applied migrations in the database itself.
await applyD1Migrations(env.ARCHIVE, env.TEST_MIGRATIONS ?? []);

// Tests never reach the network: any fetch a test has not stubbed fails loudly.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`unstubbed fetch: ${input instanceof Request ? input.url : String(input)}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
