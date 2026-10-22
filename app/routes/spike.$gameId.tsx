import { useEffect, useState } from "react";

import type { Route } from "./+types/spike.$gameId";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Spike game ${params.gameId.slice(0, 8)} · Agent Werewolves` }];
}

type GameEvent = {
  seq: number;
  type: "started" | "turn" | "finished" | "aborted";
  payload: Record<string, unknown>;
  createdAt: number;
};

type Received = GameEvent & { delayMs: number };

type Connection = "connecting" | "live" | "reconnecting" | "closed";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;

export default function SpikeGame({ params }: Route.ComponentProps) {
  const { gameId } = params;
  const [events, setEvents] = useState<Received[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    let lastSeq = 0;
    let ended = false;
    let stopped = false;
    let backoffMs = MIN_BACKOFF_MS;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/api/spike/${gameId}/ws?after=${lastSeq}`);

      socket.onopen = () => {
        backoffMs = MIN_BACKOFF_MS;
        setConnection("live");
      };

      socket.onmessage = (message) => {
        const event: GameEvent = JSON.parse(message.data);
        if (event.seq <= lastSeq) return; // Already shown.
        if (event.seq > lastSeq + 1) {
          // Missed an event: drop this socket and replay from the last one seen.
          socket?.close();
          return;
        }
        lastSeq = event.seq;
        if (event.type === "finished" || event.type === "aborted") ended = true;
        setEvents((previous) => [...previous, { ...event, delayMs: Date.now() - event.createdAt }]);
      };

      socket.onclose = () => {
        if (stopped) return;
        if (ended) {
          setConnection("closed");
          return;
        }
        setConnection("reconnecting");
        retryTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      };
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [gameId]);

  const turns = events.filter((event) => event.type === "turn");
  const end = events.find((event) => event.type === "finished" || event.type === "aborted");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-4 py-12">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Spike game</h1>
        <ConnectionBadge connection={connection} />
      </header>
      <p className="font-mono text-xs text-gray-600 dark:text-gray-400">{gameId}</p>

      <ol className="flex flex-col gap-4">
        {turns.map((event) => (
          <li key={event.seq} className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <div className="mb-1 flex justify-between gap-4 text-xs text-gray-600 dark:text-gray-400">
              <span>Turn {String(event.payload.turnNo)}</span>
              <span>
                received {(event.delayMs / 1000).toFixed(1)} s after commit
                {event.payload.cacheHit ? " · cache hit" : ""}
              </span>
            </div>
            <p>{String(event.payload.text)}</p>
          </li>
        ))}
      </ol>

      {turns.length === 0 && !end && (
        <p className="text-gray-600 dark:text-gray-400">Waiting for the first turn…</p>
      )}
      {end && (
        <p className="font-semibold">
          {end.type === "finished" ? "Finished." : `Aborted: ${String(end.payload.reason)}`}
        </p>
      )}
    </main>
  );
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const color = {
    connecting: "bg-gray-400",
    live: "bg-green-500",
    reconnecting: "bg-amber-500",
    closed: "bg-gray-400",
  }[connection];
  return (
    <span className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
      <span className={`size-2 rounded-full ${color}`} />
      {connection}
    </span>
  );
}
