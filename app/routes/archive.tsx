import { data, Form, Link, useNavigation } from "react-router";
import { cloudflareContext } from "../cloudflare-context";
import {
  buildArchiveSearchParams,
  hasActiveArchiveFilters,
  listArchivedGames,
  parseArchiveQuery,
  STANDARD_ROLES,
  type ArchiveFilter,
  type ArchivedGameSummary,
} from "../../workers/game/archive";
import { modelLabel, MODELS } from "../../workers/game/catalog";
import type { Route } from "./+types/archive";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Archive · Agent Werewolves" }];
}
export function headers() { return { "Cache-Control": "no-store" }; }

export async function loader({ request, context }: Route.LoaderArgs) {
  const init = { headers: { "Cache-Control": "no-store" } };
  const { filter, page } = parseArchiveQuery(new URL(request.url).searchParams);
  const db = context.get(cloudflareContext).env.ARCHIVE;
  try {
    const archive = await listArchivedGames(db, filter, { page });
    return data({ archive, filter, error: false as const }, init);
  } catch (error) {
    console.log(JSON.stringify({ evt: "archive_browse_failed", error: String(error) }));
    return data({ archive: null, filter, error: true as const }, init);
  }
}

const muted = "text-gray-600 dark:text-gray-400";
const field = "min-w-0 rounded border border-gray-400 bg-transparent p-2 text-sm dark:bg-gray-950";

function formatUtcTime(ms: number) {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function abortReasonLabel(reason: string | null): string | null {
  switch (reason) {
    case "spend_limit": return "spend limit";
    case "time_limit": return "time limit";
    case "safety_budget": return "safety budget";
    case "context_limit": return "context limit";
    case "invalid_model_response": return "invalid move";
    case "attempts_exhausted": return "retries exhausted";
    case "provider_error": return "provider error";
    case "cancelled": return "cancelled";
    default: return reason ? reason.replaceAll("_", " ") : null;
  }
}

function outcomeTitle(game: ArchivedGameSummary): string {
  if (game.status === "finished") return `${game.winner} win`;
  const reason = abortReasonLabel(game.abortReason);
  return reason ? `Aborted · ${reason}` : "Aborted";
}

function modelsSummary(game: ArchivedGameSummary): string {
  if (game.model !== "mixed") return modelLabel(game.model);
  const distinct = [...new Set(game.players.map(p => p.model))];
  if (distinct.length === 0) return "Mixed models";
  return `Mixed models (${distinct.map(modelLabel).join(", ")})`;
}

function matchedSeatsSummary(game: ArchivedGameSummary, filter: ArchiveFilter): string | null {
  if (!filter.model && !filter.role) return null;
  const matched = game.players.filter(p =>
    (!filter.model || p.model === filter.model) && (!filter.role || p.role === filter.role),
  );
  if (matched.length === 0) return null;
  if (filter.model && filter.role) {
    return `${modelLabel(filter.model)} as ${filter.role} (${matched.length} ${matched.length === 1 ? "seat" : "seats"})`;
  }
  if (filter.model) {
    const roles = [...new Set(matched.map(p => p.role))];
    return `${modelLabel(filter.model)} played: ${roles.join(", ")}`;
  }
  const models = [...new Set(matched.map(p => p.model))].map(modelLabel);
  return `${filter.role}: ${models.join(", ")}`;
}

function modelOptions(archivedModels: string[], activeModel?: string): string[] {
  const seen = new Set<string>(MODELS.map(m => m.id));
  const extras = archivedModels.filter(m => !seen.has(m)).sort();
  const options = [...MODELS.map(m => m.id), ...extras];
  if (activeModel && !options.includes(activeModel)) options.push(activeModel);
  return options;
}

function roleOptions(archivedRoles: string[], activeRole?: string): string[] {
  const seen = new Set<string>(STANDARD_ROLES);
  const extras = archivedRoles.filter(r => !seen.has(r)).sort();
  const options = [...STANDARD_ROLES, ...extras];
  if (activeRole && !options.includes(activeRole)) options.push(activeRole);
  return options;
}

export default function ArchivePage({ loaderData }: Route.ComponentProps) {
  const { archive, filter } = loaderData;
  const pending = useNavigation().state !== "idle";
  const hasFilters = hasActiveArchiveFilters(filter);
  const invertedDates = Boolean(filter.from && filter.to && filter.from > filter.to);
  // Remount uncontrolled inputs when URL filters change (e.g. Clear filters or back/forward).
  const filterKey = JSON.stringify([filter.model ?? "", filter.role ?? "", filter.outcome ?? "", filter.from ?? "", filter.to ?? ""]);
  const models = modelOptions(archive?.models ?? [], filter.model);
  const roles = roleOptions(archive?.roles ?? [], filter.role);

  const rangeStart = archive && archive.total > 0 ? (archive.page - 1) * archive.pageSize + 1 : 0;
  const rangeEnd = archive ? Math.min(archive.total, rangeStart + archive.games.length - 1) : 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4 text-sm">
          <Link to="/" className={`${muted} hover:underline`}>← Agent Werewolves</Link>
          <Link to="/metrics" className="font-semibold hover:underline">Metrics →</Link>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Game archive</h1>
        <p className={muted}>Browse archived games, filter by model, role, outcome or UTC date, and open any game record.</p>
      </div>

      <Form
        key={filterKey}
        method="get"
        action="/archive"
        aria-label="Filter archived games"
        className="flex flex-col gap-4 rounded-xl border border-gray-300 p-4 dark:border-gray-700"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Model</span>
            <select name="model" defaultValue={filter.model ?? ""} className={field}>
              <option value="">All models</option>
              {models.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Role</span>
            <select name="role" defaultValue={filter.role ?? ""} className={field}>
              <option value="">All roles</option>
              {roles.map(role => <option key={role} value={role}>{role}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Outcome</span>
            <select name="outcome" defaultValue={filter.outcome ?? ""} className={field}>
              <option value="">All outcomes</option>
              <option value="village">Village win</option>
              <option value="werewolves">Werewolves win</option>
              <option value="aborted">Aborted</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">From date (UTC)</span>
            <input type="date" name="from" defaultValue={filter.from ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">To date (UTC)</span>
            <input type="date" name="to" defaultValue={filter.to ?? ""} className={field} />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={`text-xs ${muted}`}>
            Selecting both a model and a role matches games where that model played that role. Dates are inclusive UTC calendar days.
          </p>
          <div className="flex items-center gap-3">
            {hasFilters && (
              <Link to="/archive" className="text-sm underline">Clear filters</Link>
            )}
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
            >
              {pending ? "Filtering…" : "Apply filters"}
            </button>
          </div>
        </div>
      </Form>

      {archive === null ? (
        <p role="alert" className="text-red-600 dark:text-red-400">Archive unavailable.</p>
      ) : archive.games.length === 0 ? (
        <div role="status" className="flex flex-col gap-2 rounded-xl border border-gray-300 p-6 text-sm dark:border-gray-700">
          {hasFilters ? (
            <>
              <p className="font-semibold">No archived games match your filters.</p>
              {invertedDates && (
                <p className={muted}>The start date ({filter.from}) is after the end date ({filter.to}).</p>
              )}
              <p className={muted}>Try broadening your model, role, outcome or date selection, or clear all filters.</p>
              <div className="mt-1">
                <Link to="/archive" className="font-semibold underline">Clear filters</Link>
              </div>
            </>
          ) : (
            <>
              <p className="font-semibold">No archived games yet.</p>
              <p className={muted}>Finished and aborted games appear here once archived.</p>
              <div className="mt-1">
                <Link to="/" className="font-semibold underline">Start a game →</Link>
              </div>
            </>
          )}
        </div>
      ) : (
        <section aria-label="Archived games" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <p className={muted}>
              {archive.totalPages > 1
                ? `Showing ${rangeStart}–${rangeEnd} of ${archive.total} archived games`
                : `${archive.total} archived ${archive.total === 1 ? "game" : "games"}${hasFilters ? " matching filters" : ""}`}
            </p>
            {archive.totalPages > 1 && (
              <p className={muted}>Page {archive.page} of {archive.totalPages}</p>
            )}
          </div>
          <ol className="flex flex-col divide-y divide-gray-200 rounded-xl border border-gray-300 dark:divide-gray-800 dark:border-gray-700">
            {archive.games.map(game => {
              const matched = matchedSeatsSummary(game, filter);
              return (
                <li key={game.id}>
                  <Link
                    to={`/games/${game.id}`}
                    className="flex flex-col gap-1 px-4 py-3 hover:bg-gray-50 sm:flex-row sm:items-center sm:justify-between sm:gap-4 dark:hover:bg-gray-900"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{outcomeTitle(game)}</p>
                      <p className={`truncate text-sm ${muted}`} title={modelsSummary(game)}>{modelsSummary(game)}</p>
                      {matched && <p className="text-xs text-amber-700 dark:text-amber-400">{matched}</p>}
                    </div>
                    <div className="flex flex-col items-start gap-0.5 text-sm sm:items-end">
                      <span className={muted}>
                        {game.seatCount} seats · {game.days} {game.days === 1 ? "day" : "days"} · {game.turns} {game.turns === 1 ? "move" : "moves"}
                        {game.totalCostUsd !== null ? ` · $${game.totalCostUsd.toFixed(4)}` : ""}
                      </span>
                      <span className={`text-xs ${muted}`}>{formatUtcTime(game.endedAt)} · View record →</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
          {archive.totalPages > 1 && (
            <nav aria-label="Archive pagination" className="flex items-center justify-between pt-2 text-sm">
              {archive.page > 1 ? (
                <Link
                  to={`/archive${buildArchiveSearchParams(filter, archive.page - 1)}`}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  ← Previous
                </Link>
              ) : <span />}
              <span className={muted}>Page {archive.page} of {archive.totalPages}</span>
              {archive.page < archive.totalPages ? (
                <Link
                  to={`/archive${buildArchiveSearchParams(filter, archive.page + 1)}`}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
                >
                  Next →
                </Link>
              ) : <span />}
            </nav>
          )}
        </section>
      )}
    </main>
  );
}
