import { validGameId } from "../game/routes";
import { parseBatchRequest } from "./plan";

export function batchRoom(env: Env, id: string) {
  return env.BATCH_ROOM.get(env.BATCH_ROOM.idFromName(`batch:${id.toLowerCase()}`));
}

const noStore = { "Cache-Control": "no-store" };

/** Called only after the access gate. Works headless with `Authorization: Bearer <key>`. */
export async function handleBatchRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/batches/")) return null;
  const parts = url.pathname.slice("/api/batches/".length).split("/");
  const crossOrigin = request.headers.has("Origin") && request.headers.get("Origin") !== url.origin;

  if (parts.length === 1 && parts[0] === "start" && request.method === "POST") {
    if (crossOrigin) return new Response("Forbidden", { status: 403 });
    if (Number(request.headers.get("Content-Length")) > 4096) return new Response("Request too large", { status: 413 });
    const body = await request.text();
    if (body.length > 4096) return new Response("Request too large", { status: 413 });
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      value = parsed as Record<string, unknown>;
    } catch { return Response.json({ error: "Expected a JSON object." }, { status: 400 }); }
    const { requestId, ...rest } = value;
    if (typeof requestId !== "string" || !validGameId(requestId)) return Response.json({ error: "Provide a request UUID." }, { status: 400 });
    const batch = parseBatchRequest(rest);
    if ("error" in batch) return Response.json({ error: batch.error }, { status: 400 });
    const id = requestId.toLowerCase();
    const result = await batchRoom(env, id).start(id, batch);
    return result.ok ? Response.json({ batchId: id, batchUrl: `/batches/${id}` }, { headers: noStore })
      : Response.json({ error: result.error }, { status: result.status });
  }

  if (validGameId(parts[0])) {
    const room = batchRoom(env, parts[0]);
    if (parts.length === 1 && request.method === "GET") {
      const snapshot = await room.snapshot();
      return snapshot ? Response.json(snapshot, { headers: noStore }) : notFound();
    }
    if (parts.length === 2 && parts[1] === "cancel" && request.method === "POST") {
      if (crossOrigin) return new Response("Forbidden", { status: 403 });
      const snapshot = await room.cancel();
      return snapshot ? Response.json(snapshot, { headers: noStore }) : notFound();
    }
  }
  return notFound();
}

function notFound() { return new Response("Not found", { status: 404 }); }
