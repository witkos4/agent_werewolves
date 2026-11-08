/**
 * One real discuss call and one real vote call per catalog model, using the
 * engine's exact request shape. Proves each model accepts the parameters and
 * returns a valid move. Needs OPENROUTER_API_KEY; spends well under $0.01.
 * Run: npm run smoke:models
 */
import { MODELS } from "../workers/game/catalog";
import { applyMove, buildRequest, createGame, validateMove, type Game } from "../workers/game/engine";
import { callOpenRouter } from "../workers/llm/openrouter";

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set (put it in .dev.vars).");
  process.exit(2);
}

/** Plays scripted moves until the game reaches `phase`. */
function advanceTo(game: Game, phase: Game["phase"]): Game {
  while (game.phase !== phase) {
    const actor = game.queue[0];
    const target = game.players.find(p => p.alive && p.id !== actor && p.role !== "Werewolf")!.id;
    game = applyMove(game, game.phase === "discuss" ? { text: "I am still thinking.", rationale: "scripted" } : { target, rationale: "scripted" });
  }
  return game;
}

let failures = 0;
let total = 0;
for (const model of MODELS) {
  const base = createGame(crypto.randomUUID(), 1, Date.now(), { seats: Array.from({ length: 5 }, () => ({ model: model.id, persona: "random" })), pool: [] });
  for (const phase of ["discuss", "vote"] as const) {
    const game = advanceTo(base, phase);
    const result = await callOpenRouter({ apiKey, body: buildRequest(game), signal: AbortSignal.timeout(30_000) });
    let outcome: string;
    if (!result.ok) outcome = `FAIL ${result.reason}`;
    else {
      try { validateMove(game, result.text); outcome = "ok"; }
      catch (error) { outcome = `FAIL ${(error as Error).message}: ${result.text.slice(0, 120)}`; }
    }
    if (outcome !== "ok") failures++;
    if (result.ok && result.cost) total += result.cost;
    console.log([model.id, phase, outcome, result.ok ? `$${result.cost ?? "?"}` : "-", result.ok ? `${result.latencyMs}ms` : "-"].join("\t"));
  }
}
console.log(`total $${total.toFixed(5)}, ${failures} failed`);
process.exit(failures ? 1 : 0);
