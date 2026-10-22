// Spike-only HTTP routes, handled before React Router. SPIKE_KEY is a
// temporary guard on everything that spends money or exposes request bodies;
// S-01's access-key gate replaces it.

const PREFIX = "/api/spike/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DELAY_MS = { min: 0, max: 300_000, fallback: 30_000 };
const HOLD_MS = { min: 0, max: 60_000, fallback: 0 };

/** Returns null for paths outside /api/spike/, so the caller falls through. */
export async function handleSpikeRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(PREFIX)) return null;

  const parts = pathname.slice(PREFIX.length).split("/");

  if (parts.length === 1 && parts[0] === "start" && request.method === "POST") {
    if (!(await hasSpikeKey(request, env))) return notFound();
    return startGame(request, env);
  }

  if (parts.length === 2 && parts[1] === "turns" && request.method === "GET") {
    if (!(await hasSpikeKey(request, env))) return notFound();
    const [gameId] = parts;
    // Never address a DO by an arbitrary name: that would create stored instances.
    if (!UUID.test(gameId)) return notFound();
    const journal = await roomFor(env, gameId).getJournal();
    if (!journal.game) return notFound();
    return Response.json(journal, { headers: { "Cache-Control": "no-store" } });
  }

  return notFound();
}

async function startGame(request: Request, env: Env): Promise<Response> {
  let options: Record<string, unknown> = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") options = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
  }

  const gameId = crypto.randomUUID();
  await roomFor(env, gameId).start({
    gameId,
    delayMs: clamp(options.delayMs, DELAY_MS),
    holdMs: clamp(options.holdMs, HOLD_MS),
    model: env.SPIKE_MODEL,
  });
  return Response.json({ gameId, viewerUrl: `/spike/${gameId}` });
}

function roomFor(env: Env, gameId: string) {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
}

async function hasSpikeKey(request: Request, env: Env): Promise<boolean> {
  const expected = env.SPIKE_KEY as string | undefined;
  const given = request.headers.get("x-spike-key");
  if (!expected || !given) return false;
  // Compare fixed-length digests in constant time, so timing leaks neither
  // the key's length nor how many leading bytes matched.
  const [a, b] = await Promise.all([sha256(expected), sha256(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function clamp(value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
