import { data, Form, redirect, useNavigation } from "react-router";
import { cloudflareContext } from "../cloudflare-context";
import { handleGameRequest } from "../../workers/game/routes";
import { MODEL, SAFETY_USD } from "../../workers/game/engine";
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

export function loader() {
  return data({ requestId: crypto.randomUUID(), model: MODEL, safetyUsd: SAFETY_USD }, { headers: { "Cache-Control": "no-store" } });
}

export function headers() { return { "Cache-Control": "no-store" }; }

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const requestId = String(form.get("requestId") ?? "");
  const headers = new Headers({ "Content-Type": "application/json" });
  if (request.headers.has("Origin")) headers.set("Origin", request.headers.get("Origin")!);
  const response = await handleGameRequest(new Request(new URL("/api/games/start", request.url), {
    method: "POST", headers,
    body: JSON.stringify({ requestId, discussionPasses: Number(form.get("discussionPasses")) }),
  }), context.get(cloudflareContext).env);
  if (!response) throw new Response("Not found", { status: 404 });
  if (!response.ok) {
    const error = response.headers.get("Content-Type")?.includes("application/json")
      ? (await response.json() as { error: string }).error : "Could not start the game.";
    return data({ error, requestId }, { status: response.status });
  }
  const { viewerUrl } = await response.json() as { viewerUrl: string };
  throw redirect(viewerUrl);
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-6">
      <p className="text-sm font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">A village. Five agents. One hidden wolf.</p>
      <h1 className="text-4xl font-bold tracking-tight">Agent Werewolves</h1>
      <p className="text-gray-600 dark:text-gray-400">
        Watch AI agents investigate, bluff and vote. One Werewolf, one Seer and three Villagers play until a team wins. Roles are revealed at the end.
      </p>
      <Form method="post" className="flex flex-col gap-5 rounded-xl border border-gray-300 p-6 dark:border-gray-700">
        <input type="hidden" name="requestId" value={actionData?.requestId || loaderData.requestId} />
        <p className="text-sm text-gray-600 dark:text-gray-400">All seats use {loaderData.model}. Roles are shuffled for each game.</p>
        <label className="flex items-center justify-between gap-4">Discussion rounds per day
          <select name="discussionPasses" defaultValue="1" disabled={pending} className="rounded border border-gray-400 bg-transparent p-2">
            <option value="1">1 round</option><option value="2">2 rounds</option>
          </select>
        </label>
        <p className="text-sm text-gray-600 dark:text-gray-400">Safety allowance: ${loaderData.safetyUsd.toFixed(2)} per game. Games stop after 45 minutes or if a model fails. Day votes are revealed together; ties eliminate a random tied player.</p>
        <button disabled={pending} className="rounded-lg bg-gray-900 px-5 py-3 font-semibold text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">
          {pending ? "Starting game…" : "Start a game"}
        </button>
        {actionData?.error && <p role="alert" className="text-red-600 dark:text-red-400">{actionData.error}</p>}
      </Form>
    </main>
  );
}
