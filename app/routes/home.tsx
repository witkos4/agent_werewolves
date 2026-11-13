import { data, Form, Link, redirect, useNavigation } from "react-router";
import { cloudflareContext } from "../cloudflare-context";
import { listRecentGames, type RecentGame } from "../../workers/game/archive";
import { handleGameRequest } from "../../workers/game/routes";
import { SAFETY_USD } from "../../workers/game/engine";
import { modelLabel, MODELS, PERSONAS } from "../../workers/game/catalog";
import { DEFAULT_SETUP, RANDOM, setupFromForm, type GameSetup } from "../../workers/game/setup";
import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Agent Werewolves" },
    {
      name: "description",
      content: "AI agents play Werewolf while you watch them bluff and reason.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  // The start form must work even when the archive is unreachable.
  let recent: RecentGame[] | null = null;
  try {
    recent = await listRecentGames(context.get(cloudflareContext).env.ARCHIVE, 20);
  } catch (error) {
    console.log(JSON.stringify({ evt: "archive_list_failed", error: String(error) }));
  }
  return data({
    requestId: crypto.randomUUID(),
    models: MODELS.map(m => ({ id: m.id, label: m.label })),
    personas: PERSONAS.map(p => ({ id: p.id, name: p.name })),
    safetyUsd: SAFETY_USD,
    recent,
  }, { headers: { "Cache-Control": "no-store" } });
}

export function headers() { return { "Cache-Control": "no-store" }; }

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const requestId = String(form.get("requestId") ?? "");
  const discussionPasses = Number(form.get("discussionPasses"));
  const setup = setupFromForm(form);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (request.headers.has("Origin")) headers.set("Origin", request.headers.get("Origin")!);
  const response = await handleGameRequest(new Request(new URL("/api/games/start", request.url), {
    method: "POST", headers,
    body: JSON.stringify({ requestId, discussionPasses, setup }),
  }), context.get(cloudflareContext).env);
  if (!response) throw new Response("Not found", { status: 404 });
  if (!response.ok) {
    const error = response.headers.get("Content-Type")?.includes("application/json")
      ? (await response.json() as { error: string }).error : "Could not start the game.";
    // Echo the choices so the form keeps them.
    return data({ error, requestId, setup, discussionPasses }, { status: response.status });
  }
  const { viewerUrl } = await response.json() as { viewerUrl: string };
  throw redirect(viewerUrl);
}

const select = "min-w-0 rounded border border-gray-400 bg-transparent p-2 dark:bg-gray-950";

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  const setup: GameSetup = actionData?.setup ?? DEFAULT_SETUP;
  // Remount the fields when the server echoes new choices, so defaults apply.
  const formKey = actionData ? JSON.stringify(actionData.setup) : "default";
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">A village. Eight agents. Two hidden wolves.</p>
      <h1 className="text-4xl font-bold tracking-tight">Agent Werewolves</h1>
      <p className="text-gray-600 dark:text-gray-400">
        Watch AI agents investigate, bluff and vote. Two Werewolves, one Seer and five Villagers play until a team wins. Seat different models and personalities at one table and compare how they play. Roles are revealed at the end.
      </p>
      <Form key={formKey} method="post" className="flex flex-col gap-5 rounded-xl border border-gray-300 p-6 dark:border-gray-700">
        <input type="hidden" name="requestId" value={actionData?.requestId || loaderData.requestId} />
        <fieldset disabled={pending} className="flex flex-col gap-2">
          <legend className="mb-2 font-semibold">Seats</legend>
          <p className="mb-1 text-sm text-gray-600 dark:text-gray-400">Roles are shuffled after seating, so a seat's model never decides its role.</p>
          {setup.seats.map((seat, i) => <div key={i} className="grid grid-cols-[4rem_1fr_1fr] items-center gap-2">
            <span className="text-sm">Seat {i + 1}</span>
            <select name="seatModel" aria-label={`Seat ${i + 1} model`} defaultValue={seat.model} className={select}>
              <option value={RANDOM}>Random from pool</option>
              {loaderData.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <select name="seatPersona" aria-label={`Seat ${i + 1} personality`} defaultValue={seat.persona} className={select}>
              <option value={RANDOM}>Random personality</option>
              {loaderData.personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>)}
        </fieldset>
        <fieldset disabled={pending} className="flex flex-col gap-2">
          <legend className="mb-2 font-semibold">Model pool</legend>
          <p className="text-sm text-gray-600 dark:text-gray-400">"Random from pool" seats draw from these. A model can be drawn more than once.</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {loaderData.models.map(m => <label key={m.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="pool" value={m.id} defaultChecked={setup.pool.includes(m.id)} />{m.label}
            </label>)}
          </div>
        </fieldset>
        <label className="flex items-center justify-between gap-4">Discussion rounds per day
          <select name="discussionPasses" defaultValue={String(actionData?.discussionPasses ?? 1)} disabled={pending} className={select}>
            <option value="1">1 round</option><option value="2">2 rounds</option>
          </select>
        </label>
        <p className="text-sm text-gray-600 dark:text-gray-400">Safety allowance: ${loaderData.safetyUsd.toFixed(2)} per game. Games stop after 45 minutes or if a model fails. Day votes are revealed together; ties eliminate a random tied player.</p>
        <button disabled={pending} className="rounded-lg bg-gray-900 px-5 py-3 font-semibold text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">
          {pending ? "Starting game…" : "Start a game"}
        </button>
        {actionData?.error && <p role="alert" className="text-red-600 dark:text-red-400">{actionData.error}</p>}
      </Form>
      <section aria-label="Recent games">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Recent games</h2>
          <Link to="/metrics" className="text-sm font-semibold hover:underline">Metrics →</Link>
        </div>
        {loaderData.recent === null ? <p className="text-sm text-gray-600 dark:text-gray-400">Archive unavailable.</p>
          : loaderData.recent.length === 0 ? <p className="text-sm text-gray-600 dark:text-gray-400">No archived games yet.</p>
          : <ol className="flex flex-col divide-y divide-gray-200 rounded-xl border border-gray-300 dark:divide-gray-800 dark:border-gray-700">
            {loaderData.recent.map(game => <li key={game.id}>
              <Link to={`/games/${game.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900">
                <span className="font-semibold">{game.status === "finished" ? `${game.winner} win` : "Stopped"}</span>
                <span className="text-sm text-gray-600 dark:text-gray-400">{game.days} {game.days === 1 ? "day" : "days"} · {modelLabel(game.model)} · {new Date(game.endedAt).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
              </Link>
            </li>)}
          </ol>}
      </section>
    </main>
  );
}
