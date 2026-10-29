import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { cloudflareContext } from "../cloudflare-context";
import { liveRoom, validGameId } from "../../workers/game/routes";
import type { PublicGame } from "../../workers/game/engine";
import type { Route } from "./+types/games.$gameId";

export function meta() { return [{ title: "Live game · Agent Werewolves" }]; }
export function headers() { return { "Cache-Control": "no-store" }; }

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!validGameId(params.gameId)) throw new Response("Game not found", { status: 404 });
  const snapshot = await liveRoom(context.get(cloudflareContext).env, params.gameId).getLiveSnapshot();
  if (!snapshot) throw new Response("Game not found", { status: 404 });
  return data(snapshot, { headers: { "Cache-Control": "no-store" } });
}

type Connection = "connecting" | "live" | "reconnecting" | "closed" | "sign-in";

export default function LiveGame({ loaderData }: Route.ComponentProps) {
  const [game, setGame] = useState(loaderData.game);
  const [connection, setConnection] = useState<Connection>(loaderData.game.status === "running" ? "connecting" : "closed");

  useEffect(() => {
    setGame(loaderData.game);
    if (loaderData.game.status !== "running") { setConnection("closed"); return; }
    let seq = loaderData.seq;
    let ended = false;
    let stopped = false;
    let backoff = 1000;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let receivedAt = performance.now();
    setConnection("connecting");

    function connect() {
      if (stopped || ended) return;
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}/api/games/${loaderData.game.id}/ws?after=${seq}`);
      socket = ws;
      ws.onopen = () => {
        receivedAt = performance.now();
        setConnection("live");
        heartbeat = setInterval(() => {
          if (performance.now() - receivedAt > 40_000) ws.close();
          else if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, 15_000);
      };
      ws.onmessage = message => {
        receivedAt = performance.now();
        backoff = 1000;
        if (message.data === "pong") return;
        try {
          const event = JSON.parse(message.data) as { seq: number; payload: PublicGame };
          if (!Number.isSafeInteger(event.seq) || !event.payload || event.payload.id !== loaderData.game.id) throw new Error("Invalid event");
          if (event.seq <= seq) return;
          if (event.seq !== seq + 1) { ws.close(); return; }
          seq = event.seq;
          setGame(event.payload);
          if (event.payload.status !== "running") {
            ended = true;
            setConnection("closed");
            ws.close();
          }
        } catch { ws.close(); }
      };
      ws.onclose = async () => {
        clearInterval(heartbeat);
        if (stopped || ended) return;
        setConnection("reconnecting");
        try {
          // A closed socket cannot convey the gate's HTTP response. Probe the
          // already-known game to distinguish expired credentials from outages.
          const response = await fetch(`/api/games/${loaderData.game.id}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
          if (stopped) return;
          if (response.status === 401 || response.status === 404) { setConnection("sign-in"); return; }
        } catch { /* Retry a transient outage with bounded backoff. */ }
        if (!stopped) {
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 10_000);
        }
      };
    }
    connect();
    return () => { stopped = true; clearTimeout(retry); clearInterval(heartbeat); socket?.close(); };
  }, [loaderData]);

  const night = game.phase === "investigate" || game.phase === "kill";
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" className="text-sm underline">Agent Werewolves</Link>
        <span role="status" className={`text-sm ${connection === "live" ? "text-green-700 dark:text-green-400" : "text-gray-600 dark:text-gray-400"}`}>{connection === "sign-in" ? "Sign-in required" : connection}</span>
      </header>
      <div>
        <p className="text-sm text-gray-600 dark:text-gray-400">{game.model}</p>
        <h1 className="mt-2 text-3xl font-bold">{game.status === "finished" ? `${game.winner} win` : game.status === "aborted" ? "Game stopped" : `${night ? "Night" : "Day"} ${game.day}`}</h1>
        {game.status === "running" && <p className="mt-2 text-gray-600 dark:text-gray-400">{night ? "The village sleeps. Night actions are private." : game.phase === "vote" ? "The village is voting. Results appear together." : "The village is discussing its suspicions."}</p>}
      </div>
      {connection === "sign-in" && <p role="alert">Your session may have expired. <a className="underline" href={`/login?next=${encodeURIComponent(`/games/${game.id}`)}`}>Sign in to reconnect</a>.</p>}
      {game.status === "aborted" && <p role="alert" className="rounded-lg border border-amber-400 p-4">{abortMessage(game.abortReason)} No winner was declared.</p>}
      <ul className="grid grid-cols-5 gap-2" aria-label="Players">
        {game.players.map(player => <li key={player.id} className={`rounded-lg border border-gray-300 p-3 text-center dark:border-gray-700 ${!player.alive ? "opacity-60" : ""}`}>
          <p className="font-semibold">{player.name}</p><p className="text-xs">{player.id} · {player.alive ? "Alive" : "Dead"}</p>
          <p className="mt-2 text-sm">{player.role || "Role hidden"}</p>
        </li>)}
      </ul>
      <section aria-label="Public transcript">
        <h2 className="mb-4 text-lg font-semibold">Village chronicle</h2>
        <ol className="flex flex-col gap-3">
          {game.transcript.map((entry, i) => <li key={i} className={`rounded-lg p-4 ${entry.kind === "speech" ? "border border-gray-300 dark:border-gray-700" : "bg-gray-100 text-sm dark:bg-gray-900"}`}>
            {entry.actor && <p className="mb-1 text-sm font-semibold">{game.players.find(p => p.id === entry.actor)?.name} · Day {entry.day}</p>}
            <p className="whitespace-pre-wrap break-words">{entry.text}</p>
          </li>)}
        </ol>
      </section>
      {game.status !== "running" && <Link to="/" className="self-start rounded-lg bg-gray-900 px-5 py-3 font-semibold text-white dark:bg-gray-100 dark:text-gray-900">Start another game</Link>}
    </main>
  );
}

function abortMessage(reason: string | null) {
  switch (reason) {
    case "time_limit": return "The game reached its 45-minute time limit.";
    case "safety_budget": return "The game reached its safety allowance.";
    case "context_limit": return "The game history reached the context safety limit.";
    case "invalid_model_response": return "An agent returned an invalid move.";
    case "attempts_exhausted": return "The provider did not respond successfully after three attempts.";
    case "provider_error": return "The model provider could not complete a turn.";
    default: return "The game stopped because of an internal error.";
  }
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <main className="mx-auto max-w-2xl p-10"><h1 className="text-2xl font-bold">{isRouteErrorResponse(error) && error.status === 404 ? "Game not found" : "Could not load this game"}</h1><Link className="mt-4 inline-block underline" to="/">Return home</Link></main>;
}
