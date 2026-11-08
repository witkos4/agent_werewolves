import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useRevalidator } from "react-router";
import { cloudflareContext } from "../cloudflare-context";
import { readArchivedRecord } from "../../workers/game/archive";
import { liveRoom, validGameId } from "../../workers/game/routes";
import type { PublicGame } from "../../workers/game/engine";
import { modelLabel, personaById } from "../../workers/game/catalog";
import type { GameRecord, TimelineItem } from "../../workers/game/record";
import type { Snapshot } from "../../workers/game/runtime";
import type { Route } from "./+types/games.$gameId";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.kind === "record" ? "Game record" : "Live game"} · Agent Werewolves` }];
}
export function headers() { return { "Cache-Control": "no-store" }; }

type PageData = { kind: "live"; snapshot: Snapshot } | { kind: "record"; record: GameRecord; archived: boolean };

/**
 * A running game is the live viewer. A terminal game is its record, read from
 * the D1 archive, or from the room (marked "archiving") until the archive lands.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  if (!validGameId(params.gameId)) throw new Response("Game not found", { status: 404 });
  const { env } = context.get(cloudflareContext);
  const id = params.gameId.toLowerCase();
  const init = { headers: { "Cache-Control": "no-store" } };
  try {
    const record = await readArchivedRecord(env.ARCHIVE, id);
    if (record) return data<PageData>({ kind: "record", record, archived: true }, init);
  } catch (error) {
    // The room still holds the game; fall through to it.
    console.log(JSON.stringify({ evt: "archive_read_failed", gameId: id, error: String(error) }));
  }
  const room = liveRoom(env, id);
  const snapshot = await room.getLiveSnapshot();
  if (!snapshot) throw new Response("Game not found", { status: 404 });
  if (snapshot.game.status === "running") return data<PageData>({ kind: "live", snapshot }, init);
  const fromRoom = await room.getRecord();
  if (!fromRoom) throw new Response("Game not found", { status: 404 });
  return data<PageData>({ kind: "record", ...fromRoom }, init);
}

export default function GamePage({ loaderData }: Route.ComponentProps) {
  return loaderData.kind === "live" ? <LiveGame snapshot={loaderData.snapshot} /> : <GameRecordView record={loaderData.record} archived={loaderData.archived} />;
}

type Connection = "connecting" | "live" | "reconnecting" | "closed" | "sign-in";

function LiveGame({ snapshot: loaderData }: { snapshot: Snapshot }) {
  const revalidator = useRevalidator();
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
            // The loader now returns the record: the page turns into it in place.
            revalidator.revalidate();
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
        <p className="text-sm text-gray-600 dark:text-gray-400">{modelLabel(game.model)}</p>
        <h1 className="mt-2 text-3xl font-bold">{game.status === "finished" ? `${game.winner} win` : game.status === "aborted" ? "Game stopped" : `${night ? "Night" : "Day"} ${game.day}`}</h1>
        {game.status === "running" && <p className="mt-2 text-gray-600 dark:text-gray-400">{night ? "The village sleeps. Night actions are private." : game.phase === "vote" ? "The village is voting. Results appear together." : "The village is discussing its suspicions."}</p>}
      </div>
      {connection === "sign-in" && <p role="alert">Your session may have expired. <a className="underline" href={`/login?next=${encodeURIComponent(`/games/${game.id}`)}`}>Sign in to reconnect</a>.</p>}
      {game.status === "aborted" && <p role="alert" className="rounded-lg border border-amber-400 p-4">{abortMessage(game.abortReason)} No winner was declared.</p>}
      <ul className="grid grid-cols-5 gap-2" aria-label="Players">
        {game.players.map(player => <li key={player.id} className={`rounded-lg border border-gray-300 p-3 text-center dark:border-gray-700 ${!player.alive ? "opacity-60" : ""}`}>
          <p className="font-semibold">{player.name}</p><p className="text-xs">{player.id} · {player.alive ? "Alive" : "Dead"}</p>
          <SeatLabel model={player.model} persona={player.persona} />
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

/** Re-reads the loader with bounded backoff until the archive lands, then stops. */
function useArchiveRefresh(archived: boolean) {
  const { revalidate } = useRevalidator();
  useEffect(() => {
    if (archived) return;
    const stopAt = Date.now() + 5 * 60_000;
    let delay = 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(() => {
        revalidate();
        delay = Math.min(delay * 2, 30_000);
        if (Date.now() < stopAt) poll();
      }, delay);
    };
    poll();
    return () => clearTimeout(timer);
  }, [archived, revalidate]);
}

function GameRecordView({ record, archived }: { record: GameRecord; archived: boolean }) {
  useArchiveRefresh(archived);
  const name = (seat: string) => record.players.find(p => p.seat === seat)?.name ?? seat;
  // Timeline labels carry the model, so readers can see who reasoned how.
  const role = (seat: string) => {
    const player = record.players.find(p => p.seat === seat);
    return player && `${player.role} · ${modelLabel(player.model)}`;
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" className="text-sm underline">Agent Werewolves</Link>
        <span role="status" className={`text-sm ${archived ? "text-gray-600 dark:text-gray-400" : "text-amber-700 dark:text-amber-400"}`}>{archived ? "Archived" : "Archiving…"}</span>
      </header>
      <div>
        <p className="text-sm text-gray-600 dark:text-gray-400">Game record · {modelLabel(record.model)}</p>
        <h1 className="mt-2 text-3xl font-bold">{record.status === "finished" ? `${record.winner} win` : "Game stopped"}</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Ended {formatTime(record.endedAt)} · {formatDuration(record.endedAt - record.createdAt)} · {record.days} {record.days === 1 ? "day" : "days"} · {record.turns} moves · {formatCost(record)}
        </p>
      </div>
      {record.status === "aborted" && <p role="alert" className="rounded-lg border border-amber-400 p-4">{abortMessage(record.abortReason)} No winner was declared.</p>}
      <ul className="grid grid-cols-5 gap-2" aria-label="Players">
        {record.players.map(player => <li key={player.seat} className={`rounded-lg border border-gray-300 p-3 text-center dark:border-gray-700 ${!player.survived ? "opacity-60" : ""}`}>
          <p className="font-semibold">{player.name}</p><p className="text-xs">{player.seat} · {player.survived ? "Survived" : "Dead"}</p>
          <SeatLabel model={player.model} persona={player.persona === null ? null : personaById(player.persona)?.name ?? player.persona} />
          <p className="mt-2 text-sm">{player.role}</p>
        </li>)}
      </ul>
      <section aria-label="Game record">
        <h2 className="mb-1 text-lg font-semibold">Village chronicle</h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">Each move shows the agent's private rationale beside it. Night actions were never public.</p>
        <ol className="flex flex-col gap-3">
          {record.timeline.map((item, i) => <TimelineEntry key={i} item={item} name={name} role={role} />)}
        </ol>
      </section>
      <Link to="/" className="self-start rounded-lg bg-gray-900 px-5 py-3 font-semibold text-white dark:bg-gray-100 dark:text-gray-900">Start another game</Link>
    </main>
  );
}

function TimelineEntry({ item, name, role }: { item: TimelineItem; name: (seat: string) => string; role: (seat: string) => string | undefined }) {
  if (!("actor" in item)) {
    return <li className="rounded-lg bg-gray-100 p-4 text-sm dark:bg-gray-900"><p className="whitespace-pre-wrap break-words">{item.text}</p></li>;
  }
  const who = `${name(item.actor)} (${role(item.actor)})`;
  if (item.kind === "speech") {
    return <li className="rounded-lg border border-gray-300 p-4 dark:border-gray-700">
      <p className="mb-1 text-sm font-semibold">{who} · Day {item.day}</p>
      <p className="whitespace-pre-wrap break-words">{item.text}</p>
      <Rationale text={item.rationale} />
    </li>;
  }
  if (item.kind === "vote") {
    return <li className="ml-6 rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700">
      <p><span className="font-semibold">{who}</span> voted for {name(item.target)}</p>
      <Rationale text={item.rationale} />
    </li>;
  }
  return <li className="rounded-lg border border-dashed border-gray-400 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300">
    <p><span className="mr-2 rounded bg-gray-200 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide dark:bg-gray-800">Private</span>
      <span className="font-semibold">{who}</span> {item.action === "investigate" ? `checked ${name(item.target)} → ${item.resultRole}` : `chose to kill ${name(item.target)}`}</p>
    <Rationale text={item.rationale} />
  </li>;
}

/** A seat's model and personality; neither reveals a role. */
function SeatLabel({ model, persona }: { model: string; persona: string | null }) {
  return <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
    <span className="block truncate" title={model}>{modelLabel(model)}</span>
    {persona && <span className="block truncate" title={persona}>{persona}</span>}
  </p>;
}

function Rationale({ text }: { text: string }) {
  return <p className="mt-2 border-l-2 border-amber-500 pl-3 text-sm italic text-gray-700 dark:text-gray-300"><span className="sr-only">Private rationale: </span>{text}</p>;
}

/** UTC, so server and browser render the same text. */
function formatTime(ms: number) { return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`; }
function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
function formatCost(record: GameRecord) {
  if (record.totalCostUsd === null) return "cost unknown";
  const cost = `$${record.totalCostUsd.toFixed(4)}`;
  return record.unknownCostTurns ? `${cost} (${record.unknownCostTurns} moves cost unknown)` : cost;
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
