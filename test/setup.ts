import { afterEach, beforeEach, vi } from "vitest";

// Tests never reach the network: any fetch a test has not stubbed fails loudly.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`unstubbed fetch: ${input instanceof Request ? input.url : String(input)}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
