const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function liveRoom(env: Env, id: string) {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(`live:${id.toLowerCase()}`));
}
export function validGameId(id: string) { return UUID.test(id); }

/** Called only after the access gate, in both production and the test entry. */
export async function handleGameRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/games/")) return null;
  const parts = url.pathname.slice("/api/games/".length).split("/");
  if (parts.length === 1 && parts[0] === "start" && request.method === "POST") {
    if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return new Response("Forbidden", { status: 403 });
    if (Number(request.headers.get("Content-Length")) > 2048) return new Response("Request too large", { status: 413 });
    const body = await request.text();
    if (body.length > 2048) return new Response("Request too large", { status: 413 });
    let options: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(body);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      options = value as Record<string, unknown>;
    } catch { return Response.json({ error: "Expected a JSON object." }, { status: 400 }); }
    if (typeof options.requestId !== "string" || !validGameId(options.requestId) || ![1, 2].includes(options.discussionPasses as number) || Object.keys(options).some(k => !["requestId", "discussionPasses"].includes(k))) {
      return Response.json({ error: "Provide a request UUID and one or two discussion passes." }, { status: 400 });
    }
    const id = options.requestId.toLowerCase();
    const result = await liveRoom(env, id).startLive(id, options.discussionPasses as number);
    return result.ok ? Response.json({ gameId: id, viewerUrl: `/games/${id}` }, { headers: { "Cache-Control": "no-store" } })
      : Response.json({ error: result.error }, { status: result.status });
  }
  if (validGameId(parts[0]) && request.method === "GET") {
    const room = liveRoom(env, parts[0]);
    if (parts.length === 1) {
      const snapshot = await room.getLiveSnapshot();
      return snapshot ? Response.json(snapshot, { headers: { "Cache-Control": "no-store" } }) : notFound();
    }
    if (parts.length === 2 && parts[1] === "ws") return room.fetch(request);
  }
  return notFound();
}

function notFound() { return new Response("Not found", { status: 404 }); }
