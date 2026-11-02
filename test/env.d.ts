import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only: the ./migrations folder, read by vitest.config.ts. */
      TEST_MIGRATIONS?: D1Migration[];
    }
  }
}
