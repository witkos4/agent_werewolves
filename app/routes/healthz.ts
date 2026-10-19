import { cloudflareContext } from "~/cloudflare-context";

import type { Route } from "./+types/healthz";

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { id, tag, timestamp } = env.CF_VERSION_METADATA;

  return Response.json(
    {
      status: "ok",
      environment: env.APP_ENV,
      version: { id, tag, timestamp },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
