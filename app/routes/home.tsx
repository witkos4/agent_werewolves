import { useState, type FormEvent } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import { cloudflareContext } from "../cloudflare-context";
import { listRecentGames, type RecentGame } from "../../workers/game/archive";
import { handleGameRequest } from "../../workers/game/routes";
import { SAFETY_USD, SPEND_LIMIT_MAX, SPEND_LIMIT_MIN } from "../../workers/game/engine";
import { estimateCost, readEstimateInputs, type EstimateInputs } from "../../workers/game/estimate";
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
  const db = context.get(cloudflareContext).env.ARCHIVE;
  let recent: RecentGame[] | null = null;
  let estimateInputs: EstimateInputs | null = null;
  try {
    recent = await listRecentGames(db, 20);
  } catch (error) {
    console.log(JSON.stringify({ evt: "archive_list_failed", error: String(error) }));
  }
  try {
    estimateInputs = await readEstimateInputs(db);
  } catch (error) {
    console.log(JSON.stringify({ evt: "estimate_inputs_failed", error: String(error) }));
  }
  return data({
    requestId: crypto.randomUUID(),
    models: MODELS.map(m => ({ id: m.id, label: m.label })),
    personas: PERSONAS.map(p => ({ id: p.id, name: p.name })),
    spendLimit: { default: SAFETY_USD, min: SPEND_LIMIT_MIN, max: SPEND_LIMIT_MAX },
    estimateInputs,
    recent,
  }, { headers: { "Cache-Control": "no-store" } });
}

export function headers() { return { "Cache-Control": "no-store" }; }

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const requestId = String(form.get("requestId") ?? "");
  const discussionPasses = Number(form.get("discussionPasses"));
  const setup = setupFromForm(form);
  // Blank means the default limit; anything non-numeric reaches the API as null and is rejected there.
  const spendLimit = String(form.get("spendLimitUsd") ?? "").trim();
  const spendLimitUsd = spendLimit === "" ? undefined : Number(spendLimit);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (request.headers.has("Origin")) headers.set("Origin", request.headers.get("Origin")!);
  const response = await handleGameRequest(new Request(new URL("/api/games/start", request.url), {
    method: "POST", headers,
    body: JSON.stringify({ requestId, discussionPasses, setup, spendLimitUsd }),
  }), context.get(cloudflareContext).env);
  if (!response) throw new Response("Not found", { status: 404 });
  if (!response.ok) {
    const error = response.headers.get("Content-Type")?.includes("application/json")
      ? (await response.json() as { error: string }).error : "Could not start the game.";
    // Echo the choices so the form keeps them.
    return data({ error, requestId, setup, discussionPasses, spendLimit }, { status: response.status });
  }
  const { viewerUrl } = await response.json() as { viewerUrl: string };
  throw redirect(viewerUrl);
}

const select = "min-w-0 rounded border border-gray-400 bg-transparent p-2 dark:bg-gray-950";

function formatUsd(usd: number) { return `$${usd < 0.1 ? usd.toFixed(4) : usd.toFixed(2)}`; }

/** The estimate line under the limit field; recomputed in the browser as the form changes. */
function EstimateLine({ inputs, setup, passes, limit }: { inputs: EstimateInputs | null; setup: GameSetup; passes: number; limit: number }) {
  const muted = "text-sm text-gray-600 dark:text-gray-400";
  if (!inputs) return <p className={muted}>No estimate: the archive is unavailable.</p>;
  const estimate = estimateCost(setup, passes, inputs);
  if (estimate.usd === null) return <p className={muted}>No estimate yet: no finished {setup.seats.length}-seat games in the archive.</p>;
  const notes = [
    `from ${estimate.games} finished ${estimate.games === 1 ? "game" : "games"}${estimate.exactShape ? "" : " with the other discussion setting"}`,
    ...(estimate.missing.length ? [`upper bound for ${estimate.missing.map(modelLabel).join(", ")} (no cost history)`] : []),
  ];
  return <>
    <p className={muted} data-testid="estimate">Estimated cost ≈ {formatUsd(estimate.usd)} · {notes.join(" · ")}</p>
    {Number.isFinite(limit) && estimate.usd > limit && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
      The estimate is above your spend limit, so the game will likely stop before a team wins.
    </p>}
  </>;
}

type StartFormProps = {
  loaderData: Route.ComponentProps["loaderData"];
  actionData: Route.ComponentProps["actionData"];
  pending: boolean;
};

function StartForm({ loaderData, actionData, pending }: StartFormProps) {
  const setup: GameSetup = actionData?.setup ?? DEFAULT_SETUP;
  const initialLimit = actionData?.spendLimit || loaderData.spendLimit.default.toFixed(2);
  const [current, setCurrent] = useState({ setup, passes: actionData?.discussionPasses ?? 1, limit: Number(initialLimit) });
  const onChange = (event: FormEvent<HTMLFormElement>) => {
    const form = new FormData(event.currentTarget);
    setCurrent({ setup: setupFromForm(form), passes: Number(form.get("discussionPasses")), limit: Number(form.get("spendLimitUsd")) });
  };
  const { min, max } = loaderData.spendLimit;
  return (
      <Form method="post" onChange={onChange} className="flex flex-col gap-5 rounded-xl border border-gray-300 p-6 dark:border-gray-700">
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
        <div className="flex flex-col gap-2">
          <label className="flex items-center justify-between gap-4">Spend limit (USD)
            <input type="number" name="spendLimitUsd" inputMode="decimal" step="0.01" min={min} max={max} defaultValue={initialLimit}
              disabled={pending} className={`${select} w-28 text-right`} />
          </label>
          <EstimateLine inputs={loaderData.estimateInputs} setup={current.setup} passes={current.passes} limit={current.limit} />
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">Limits run from ${min.toFixed(2)} to ${max.toFixed(2)}. A game stops before any model call that could take it past its limit, after 45 minutes, or if a model fails. Day votes are revealed together; ties eliminate a random tied player.</p>
        <button disabled={pending} className="rounded-lg bg-gray-900 px-5 py-3 font-semibold text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">
          {pending ? "Starting game…" : "Start a game"}
        </button>
        {actionData?.error && <p role="alert" className="text-red-600 dark:text-red-400">{actionData.error}</p>}
      </Form>
  );
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  // Remount the fields when the server echoes new choices, so defaults apply.
  const formKey = actionData ? JSON.stringify([actionData.setup, actionData.discussionPasses, actionData.spendLimit]) : "default";
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">A village. Eight agents. Two hidden wolves.</p>
      <h1 className="text-4xl font-bold tracking-tight">Agent Werewolves</h1>
      <p className="text-gray-600 dark:text-gray-400">
        Watch AI agents investigate, bluff and vote. Two Werewolves, one Seer and five Villagers play until a team wins. Seat different models and personalities at one table and compare how they play. Roles are revealed at the end.
      </p>
      <StartForm key={formKey} loaderData={loaderData} actionData={actionData} pending={pending} />
      <section aria-label="Recent games">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-semibold">Recent games</h2>
          <div className="flex items-center gap-4 text-sm font-semibold">
            <Link to="/archive" className="hover:underline">Browse archive →</Link>
            <Link to="/metrics" className="hover:underline">Metrics →</Link>
          </div>
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
