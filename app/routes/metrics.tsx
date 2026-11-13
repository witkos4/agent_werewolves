import type { ReactNode } from "react";
import { data, Link } from "react-router";
import { cloudflareContext } from "../cloudflare-context";
import { modelLabel } from "../../workers/game/catalog";
import { loadMetrics, type Figure, type Metrics } from "../../workers/game/metrics";
import type { Route } from "./+types/metrics";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Metrics · Agent Werewolves" }];
}
export function headers() { return { "Cache-Control": "no-store" }; }

export async function loader({ request, context }: Route.LoaderArgs) {
  const init = { headers: { "Cache-Control": "no-store" } };
  const raw = new URL(request.url).searchParams.get("seats");
  const db = context.get(cloudflareContext).env.ARCHIVE;
  try {
    const all = await loadMetrics(db);
    // Only seat counts that exist are filters; anything else shows every table size.
    const seats = raw !== null && all.seatCounts.includes(Number(raw)) ? Number(raw) : null;
    const metrics = seats === null ? all : await loadMetrics(db, { seats });
    return data({ metrics: { ...metrics, seatCounts: all.seatCounts }, seats, error: false as const }, init);
  } catch (error) {
    console.log(JSON.stringify({ evt: "metrics_failed", error: String(error) }));
    return data({ metrics: null, seats: null, error: true as const }, init);
  }
}

const muted = "text-gray-600 dark:text-gray-400";
const pct = (v: number | null) => v === null ? "—" : `${Math.round(v * 100)}%`;
const num = (v: number | null, digits = 2) => v === null ? "—" : v.toFixed(digits);
const games = (n: number) => `${n} ${n === 1 ? "game" : "games"}`;

/** A percentage with its raw counts and game count. */
function Ratio({ f, unit }: { f: Figure; unit: string }) {
  return <><span className="font-semibold">{pct(f.value)}</span> <span className={`text-xs ${muted}`}>{f.numerator}/{f.denominator} {unit} · {games(f.games)}</span></>;
}
/** A mean or rate with its basis. */
function Rate({ f, unit, digits = 2 }: { f: Figure; unit: string; digits?: number }) {
  return <><span className="font-semibold">{num(f.value, digits)}</span> <span className={`text-xs ${muted}`}>{f.numerator}/{f.denominator} {unit} · {games(f.games)}</span></>;
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return <div className="overflow-x-auto rounded-xl border border-gray-300 dark:border-gray-700">
    <table className="w-full text-left text-sm">
      <thead className={`border-b border-gray-300 dark:border-gray-700 ${muted}`}><tr>{head.map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-200 dark:divide-gray-800">{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-3 py-2 align-top">{c}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3" aria-label={title}>
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className={`text-sm ${muted}`}>{note}</p>
    {children}
  </section>;
}

function Body({ m }: { m: Metrics }) {
  return <>
    <Section title="Win rate" note="Every seat on the winning side wins for the role it played, alive or dead. Finished games only.">
      <Table head={["Model", "All roles", "Werewolf", "Seer", "Villager"]} rows={m.winRate.byModel.map(({ model, figure }) => [
        modelLabel(model), <Ratio f={figure} unit="seats" />,
        ...(["Werewolf", "Seer", "Villager"] as const).map(role => {
          const cell = m.winRate.byModelRole.find(r => r.model === model && r.role === role);
          return cell ? <Ratio f={cell.figure} unit="seats" /> : "—";
        }),
      ])} />
    </Section>

    <Section title="Vote accuracy" note="Per vote: day votes by non-wolves that hit a Werewolf, by the voter's model. Per elimination: village eliminations that removed a Werewolf, for the whole table.">
      <Table head={["Voter model", "Per vote"]} rows={[
        ...m.voteAccuracy.perVoteByModel.map(({ model, figure }) => [modelLabel(model), <Ratio f={figure} unit="votes" />]),
        [<span className="font-semibold">All models</span>, <Ratio f={m.voteAccuracy.perVote} unit="votes" />],
      ]} />
      <p className="text-sm">Per elimination: <Ratio f={m.voteAccuracy.perElimination} unit="eliminations" /></p>
    </Section>

    <Section title="Deception" note="By the wolf's model. Survival: day votes a wolf outlasted. Misdirected: non-wolf votes on innocents at that model's tables. Suspicion: non-wolf votes drawn per round alive, wolves vs innocents at the same tables (ratio below 1 means the wolves dodged).">
      <Table head={["Wolf model", "Rounds survived", "Votes misdirected", "Votes drawn: wolf", "Votes drawn: innocent", "Ratio"]} rows={m.deception.map(d => [
        d.model === null ? <span className="font-semibold">All wolves</span> : modelLabel(d.model),
        <><Rate f={d.survival} unit="wolves" /><div className={`text-xs ${muted}`}>of {num(d.roundsHeld, 1)} rounds held</div></>,
        <Ratio f={d.misdirected} unit="votes" />,
        <Rate f={d.wolfRate} unit="seat-rounds" />,
        <Rate f={d.innocentRate} unit="seat-rounds" />,
        <span className="font-semibold">{num(d.suspicionRatio)}</span>,
      ])} />
    </Section>

    <Section title="Cost and latency" note="Every archived game, aborted ones included. Turns are attributed to the acting seat's model; unknown-cost turns are left out of costs.">
      <Table head={["Model", "Turns", "Known cost", "Per turn", "Mean latency", "Games"]} rows={m.cost.byModel.map(c => [
        modelLabel(c.model), <>{c.turns}{c.unknownCostTurns ? <span className={`text-xs ${muted}`}> ({c.unknownCostTurns} unknown cost)</span> : null}</>,
        `$${c.costUsd.toFixed(4)}`, c.costPerTurnUsd === null ? "—" : `$${c.costPerTurnUsd.toFixed(5)}`,
        c.meanLatencyMs === null ? "—" : `${Math.round(c.meanLatencyMs)} ms`, c.games,
      ])} />
      <Table head={["Games", "Count", "Mean cost per game", "Mean turns"]} rows={m.cost.byStatus.map(s => [
        s.status === "finished" ? "Finished" : "Aborted",
        <>{s.games}{s.unknownCostGames ? <span className={`text-xs ${muted}`}> ({s.unknownCostGames} with no known cost)</span> : null}</>,
        s.meanCostUsd === null ? "—" : `$${s.meanCostUsd.toFixed(4)}`, num(s.meanTurns, 1),
      ])} />
    </Section>
  </>;
}

export default function MetricsPage({ loaderData }: Route.ComponentProps) {
  const { metrics, seats } = loaderData;
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <Link to="/" className={`text-sm ${muted} hover:underline`}>← Agent Werewolves</Link>
        <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
        <p className={muted}>How each model plays, from the archive. Every figure shows what it is based on; small counts mean little.</p>
      </div>
      {metrics === null ? <p role="alert" className="text-red-600 dark:text-red-400">Archive unavailable.</p> : <>
        <nav aria-label="Table size" className="flex flex-wrap items-center gap-2 text-sm">
          <span className={muted}>Table size:</span>
          {[null, ...metrics.seatCounts].map(n => <Link key={n ?? "all"} to={n === null ? "/metrics" : `/metrics?seats=${n}`}
            aria-current={n === seats ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${n === seats ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900" : "border-gray-300 dark:border-gray-700"}`}>
            {n === null ? "All" : `${n} seats`}</Link>)}
          <span className={muted}>· {games(metrics.finishedGames)} finished</span>
        </nav>
        {metrics.finishedGames === 0 && metrics.cost.byModel.length === 0 ? <p className={muted}>No finished games yet.</p> : <Body m={metrics} />}
      </>}
    </main>
  );
}
