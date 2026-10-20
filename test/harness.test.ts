import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("uses fake secrets, never the real ones from .dev.vars", () => {
  expect(env.OPENROUTER_API_KEY).toBe("test-openrouter-key");
  expect(env.SPIKE_KEY).toBe("test-spike-key");
});
