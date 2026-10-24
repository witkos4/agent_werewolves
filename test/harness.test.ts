import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("uses fake secrets, never the real ones from .dev.vars", () => {
  expect(env.OPENROUTER_API_KEY).toBe("test-openrouter-key");
  expect(env.ACCESS_KEY).toBe("test-access-key-0123456789abcdefghij");
});
