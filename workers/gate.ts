// Access-key gate (FR-001): runs before spike routing and React Router, so it
// covers pages, `.data` requests, the API and WebSocket upgrades alike.

import { configuredKey, isAuthenticated, misconfiguration } from "../app/access.server";

const PUBLIC_PATHS = new Set(["/login", "/healthz"]);

/** Returns null to let the request through, or the refusal to send. */
export async function gate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (PUBLIC_PATHS.has(url.pathname)) return null;

  if (!configuredKey(env)) {
    console.error(JSON.stringify({ event: "access_gate_misconfigured", reason: misconfiguration(env) }));
  } else if (await isAuthenticated(request, env, Date.now())) {
    return null;
  }

  if (isPageRequest(request, url)) {
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, { status: 302, headers: { Location: `/login?next=${next}` } });
  }
  // Reveal nothing about what exists behind the gate.
  return new Response("Not found", { status: 404 });
}

function isPageRequest(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return false;
  const path = url.pathname;
  return !path.startsWith("/api/") && !path.endsWith(".data") && path !== "/__manifest";
}
