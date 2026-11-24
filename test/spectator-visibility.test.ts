import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, RouterContextProvider, StaticRouterProvider, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../app/cloudflare-context";
import GamePage, { loader as gameLoader } from "../app/routes/games.$gameId";
import {
  applyRevealedRoles,
  extractRoles,
  hideRolesVisually,
  initialRoleVisibility,
  roleVisibilityNote,
  showCachedRoles,
  visibleRole,
} from "../app/spectator-roles";
import { applyMove, createGame, publicGame, type Game, type PublicGame, type Role } from "../workers/game/engine";
import { wantsRevealedRoles } from "../workers/game/routes";
import { archiveTuning, liveTuning, type Snapshot } from "../workers/game/runtime";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { catalog, ok, playToFinish, readGame, startLiveGame, stubVillageWin } from "./live-helpers";

const HOUR = 3600_000;
const AUTH = { Authorization: `Bearer ${env.ACCESS_KEY}` };
const defaults = { ...liveTuning };
const archiveDefaults = { ...archiveTuning };
let previous: LlmCall;

beforeEach(() => {
  Object.assign(liveTuning, { firstDelayMs: HOUR, nextDelayMs: HOUR, timeoutMs: 100 });
  archiveTuning.firstDelayMs = HOUR;
  vi.mocked(fetch).mockImplementation(async () => catalog());
  previous = setLlmCall(async () => ok("invalid"));
});

afterEach(() => {
  Object.assign(liveTuning, defaults);
  Object.assign(archiveTuning, archiveDefaults);
  setLlmCall(previous);
});

function routeArgs(path: string, params: Record<string, string> = {}) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  const request = new Request(`https://example.test${path}`);
  return { request, context, params, url: new URL(request.url), pattern: "/games/:gameId" } as never;
}

async function loadGamePage(path: string, id: string) {
  const result = await gameLoader(routeArgs(path, { gameId: id }));
  return (result as unknown as { data: Awaited<ReturnType<typeof gameLoader>>["data"] }).data;
}

async function connectWs(id: string, query: string) {
  const response = await SELF.fetch(`https://example.test/api/games/${id}/ws?${query}`, {
    headers: { ...AUTH, Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const raw: string[] = [];
  ws.addEventListener("message", event => { raw.push(String(event.data)); });
  ws.accept();
  return { ws, raw };
}

function expectNoRoles(game: PublicGame, serialized: string) {
  expect(game.players.every(p => !Object.hasOwn(p, "role"))).toBe(true);
  for (const role of ["Werewolf", "Seer", "Villager"]) {
    expect(serialized).not.toContain(role);
  }
}

function expectExactRoles(actual: PublicGame, expected: Game) {
  expect(actual.players.map(p => [p.id, p.role])).toEqual(expected.players.map(p => [p.id, p.role]));
}

async function renderLiveGameHtml(snapshot: Snapshot) {
  const path = `/games/${snapshot.game.id}`;
  function RouteWrapper() {
    const loaderData = useLoaderData();
    return createElement(GamePage, { loaderData } as never);
  }
  const routes = [{
    id: "game",
    path: "/games/:gameId",
    loader: () => ({ kind: "live" as const, snapshot }),
    Component: RouteWrapper,
  }];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`https://example.test${path}`));
  if (context instanceof Response) throw new Error(`Unexpected response: ${context.status}`);
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
}

describe("spectator role visibility projection & opt-in parsing", () => {
  it("parses roles query parameter strictly and fails closed to hidden", () => {
    for (const query of ["", "?roles=", "?roles=hidden", "?roles=true", "?roles=1", "?roles=SHOWN", "?roles=show"]) {
      expect(wantsRevealedRoles(new URL(`https://example.test/api/games/id${query}`))).toBe(false);
    }
    expect(wantsRevealedRoles(new URL("https://example.test/api/games/id?roles=shown"))).toBe(true);
  });

  it("hides roles by default while running and exposes only authoritative roles on explicit reveal", () => {
    let game = createGame("vis-engine", 1, 100, undefined, length => length - 1);
    game = applyMove(game, { target: "p1", rationale: "seer-secret-sentinel" }, () => 0);

    const hiddenDefault = publicGame(game);
    const hiddenExplicit = publicGame(game, { revealRoles: false });
    expectNoRoles(hiddenDefault, JSON.stringify(hiddenDefault));
    expectNoRoles(hiddenExplicit, JSON.stringify(hiddenExplicit));

    const revealed = publicGame(game, { revealRoles: true });
    expectExactRoles(revealed, game);
    const serialized = JSON.stringify(revealed);
    for (const secret of ["seer-secret-sentinel", "investigations", "privateMoves", "queue", "votes", "teamKillVotes"]) {
      expect(serialized).not.toContain(secret);
    }

    const finished = publicGame({ ...game, status: "finished", winner: "Village" });
    expectExactRoles(finished, game);
  });
});

describe("spectator role visibility HTTP and WebSocket boundaries", () => {
  it("keeps hidden roles out of unrevealed snapshots, loader data, and WebSocket events even while another spectator reveals", async () => {
    const { room, id } = await startLiveGame();
    const authoritative = await readGame(room);
    await stubVillageWin(room, "ws-secret-rationale");

    // Unrevealed HTTP snapshots (default, explicit hidden, and malformed values) disclose no roles.
    for (const suffix of ["", "?roles=hidden", "?roles=true", "?roles=SHOWN"]) {
      const response = await SELF.fetch(`https://example.test/api/games/${id}${suffix}`, { headers: AUTH });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const text = await response.text();
      expectNoRoles((JSON.parse(text) as Snapshot).game, text);
    }

    // Unauthenticated reveal request is blocked by the access gate.
    expect((await SELF.fetch(`https://example.test/api/games/${id}?roles=shown`)).status).toBe(404);

    // Explicit reveal HTTP snapshot discloses every authoritative role and no private reasoning.
    const revealedRes = await SELF.fetch(`https://example.test/api/games/${id}?roles=shown`, { headers: AUTH });
    expect(revealedRes.status).toBe(200);
    expect(revealedRes.headers.get("Cache-Control")).toBe("no-store");
    const revealedText = await revealedRes.text();
    expectExactRoles((JSON.parse(revealedText) as Snapshot).game, authoritative);
    expect(revealedText).not.toContain("ws-secret-rationale");

    // Unrevealed and revealed WebSockets connected concurrently to the same live room.
    const hiddenWs = await connectWs(id, "after=0");
    const explicitHiddenWs = await connectWs(id, "after=0&roles=hidden");
    const revealedWs = await connectWs(id, "after=0&roles=shown");

    await vi.waitFor(() => {
      expect(hiddenWs.raw).toHaveLength(1);
      expect(explicitHiddenWs.raw).toHaveLength(1);
      expect(revealedWs.raw).toHaveLength(1);
    });

    // Backlog check: unrevealed sockets have no roles; revealed socket has exact roles.
    expectNoRoles(JSON.parse(hiddenWs.raw[0]).payload, hiddenWs.raw[0]);
    expectNoRoles(JSON.parse(explicitHiddenWs.raw[0]).payload, explicitHiddenWs.raw[0]);
    expectExactRoles(JSON.parse(revealedWs.raw[0]).payload, authoritative);

    // Advance one turn (Seer investigation): verify live broadcast isolation.
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => {
      expect(hiddenWs.raw).toHaveLength(2);
      expect(explicitHiddenWs.raw).toHaveLength(2);
      expect(revealedWs.raw).toHaveLength(2);
    });
    expectNoRoles(JSON.parse(hiddenWs.raw[1]).payload, hiddenWs.raw[1]);
    expectNoRoles(JSON.parse(explicitHiddenWs.raw[1]).payload, explicitHiddenWs.raw[1]);
    expectExactRoles(JSON.parse(revealedWs.raw[1]).payload, authoritative);
    for (const msg of [hiddenWs.raw[1], explicitHiddenWs.raw[1], revealedWs.raw[1]]) {
      expect(msg).not.toContain("ws-secret-rationale");
    }

    // Hibernate/evict the Durable Object: attachment-persisted reveal state must survive without leaking.
    await evictDurableObject(room);
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => {
      expect(hiddenWs.raw).toHaveLength(3);
      expect(explicitHiddenWs.raw).toHaveLength(3);
      expect(revealedWs.raw).toHaveLength(3);
    });
    expectNoRoles(JSON.parse(hiddenWs.raw[2]).payload, hiddenWs.raw[2]);
    expectNoRoles(JSON.parse(explicitHiddenWs.raw[2]).payload, explicitHiddenWs.raw[2]);
    expectExactRoles(JSON.parse(revealedWs.raw[2]).payload, authoritative);

    // Play the rest of the game to completion and verify the existing end-of-game reveal for both viewers.
    for (let i = 0; i < 80 && (await readGame(room)).status === "running"; i++) {
      await runDurableObjectAlarm(room);
    }
    const finalGame = await readGame(room);
    expect(finalGame.status).toBe("finished");

    await vi.waitFor(() => {
      expect(JSON.parse(hiddenWs.raw.at(-1)!).type).toBe("finished");
      expect(JSON.parse(revealedWs.raw.at(-1)!).type).toBe("finished");
    });

    // Every pre-finished event sent to the unrevealed socket disclosed zero hidden roles.
    for (const raw of hiddenWs.raw.slice(0, -1)) {
      const event = JSON.parse(raw) as { type: string; payload: PublicGame };
      expect(event.type).not.toBe("finished");
      expectNoRoles(event.payload, raw);
    }
    // The finished event reveals every role to both unrevealed and revealed sockets.
    expectExactRoles(JSON.parse(hiddenWs.raw.at(-1)!).payload, finalGame);
    expectExactRoles(JSON.parse(revealedWs.raw.at(-1)!).payload, finalGame);

    // Unrevealed snapshot API also reveals every role once the game finishes.
    const endedRes = await SELF.fetch(`https://example.test/api/games/${id}`, { headers: AUTH });
    expect(endedRes.status).toBe(200);
    expectExactRoles((await endedRes.json() as Snapshot).game, finalGame);

    hiddenWs.ws.close();
    explicitHiddenWs.ws.close();
    revealedWs.ws.close();
  });

  it("fails closed for legacy hibernated sockets whose attachment has no revealRoles flag", async () => {
    const { room, id } = await startLiveGame();
    await stubVillageWin(room, "legacy-secret");
    const legacy = await connectWs(id, "after=0");
    await vi.waitFor(() => expect(legacy.raw).toHaveLength(1));

    await runInDurableObject(room, (_instance, state) => {
      const ws = state.getWebSockets()[0];
      const existing = ws.deserializeAttachment() as { keyFingerprint: string; openedAt: number };
      ws.serializeAttachment({ keyFingerprint: existing.keyFingerprint, openedAt: existing.openedAt });
    });

    await evictDurableObject(room);
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => expect(legacy.raw).toHaveLength(2));
    expectNoRoles(JSON.parse(legacy.raw[1]).payload, legacy.raw[1]);
    legacy.ws.close();
  });

  it("gates hidden roles in the game page loader until explicitly revealed and preserves end-of-game reveal", async () => {
    const { room, id } = await startLiveGame();
    const authoritative = await readGame(room);
    await stubVillageWin(room, "loader-secret-rationale");
    await runDurableObjectAlarm(room);

    // Default and hidden loader responses omit hidden roles.
    for (const path of [`/games/${id}`, `/games/${id}?roles=hidden`, `/games/${id}?roles=true`]) {
      const page = await loadGamePage(path, id);
      expect(page.kind).toBe("live");
      if (page.kind !== "live") throw new Error("expected live");
      expectNoRoles(page.snapshot.game, JSON.stringify(page));
      expect(JSON.stringify(page)).not.toContain("loader-secret-rationale");
    }

    // Explicit reveal loader response includes every role and still omits private reasoning.
    const revealedPage = await loadGamePage(`/games/${id}?roles=shown`, id);
    expect(revealedPage.kind).toBe("live");
    if (revealedPage.kind !== "live") throw new Error("expected live");
    expectExactRoles(revealedPage.snapshot.game, authoritative);
    expect(JSON.stringify(revealedPage)).not.toContain("loader-secret-rationale");

    // End-of-game reveal still returns the full record with every role without ?roles=shown.
    await playToFinish(room, "loader-secret-rationale");
    const endedPage = await loadGamePage(`/games/${id}`, id);
    expect(endedPage.kind).toBe("record");
    if (endedPage.kind !== "record") throw new Error("expected record");
    expect(endedPage.record.players.map(p => [p.seat, p.role])).toEqual(authoritative.players.map(p => [p.id, p.role]));
  });
});

describe("spectator role visibility UI state and rendering", () => {
  it("switches from hidden to shown, stays shown across unrevealed live updates, hides visually on switch-back, and always reveals at game end", () => {
    const raw = createGame("ui-state", 1, 100, undefined, length => length - 1);
    const hiddenSnapshot = publicGame(raw);
    const revealedSnapshot = publicGame(raw, { revealRoles: true });
    const finishedSnapshot = publicGame({ ...raw, status: "finished", winner: "Village" });

    // Starts hidden with no disclosed roles.
    let state = initialRoleVisibility(hiddenSnapshot);
    expect(state).toEqual({ showRoles: false, hasRevealed: false, revealedRoles: null });
    expect(roleVisibilityNote(state)).toContain("not sent");
    for (const p of hiddenSnapshot.players) expect(visibleRole(hiddenSnapshot, state, p)).toBeNull();

    // Explicit reveal shows every role and keeps showing them across subsequent unrevealed updates.
    const roles = extractRoles(revealedSnapshot)!;
    expect(roles).not.toBeNull();
    state = applyRevealedRoles(roles);
    expect(state.showRoles).toBe(true);
    expect(state.hasRevealed).toBe(true);
    expect(roleVisibilityNote(state)).toContain("visually only");
    for (const p of hiddenSnapshot.players) {
      expect(visibleRole(hiddenSnapshot, state, p)).toBe(raw.players.find(r => r.id === p.id)!.role);
    }

    // Switching back hides roles visually and clearly states prior data cannot be made secret again.
    state = hideRolesVisually(state);
    expect(state.showRoles).toBe(false);
    expect(state.hasRevealed).toBe(true);
    expect(roleVisibilityNote(state)).toContain("visually only");
    expect(roleVisibilityNote(state)).toContain("cannot be made secret again");
    for (const p of hiddenSnapshot.players) expect(visibleRole(hiddenSnapshot, state, p)).toBeNull();

    // Switching back to shown reuses the already-revealed roles.
    state = showCachedRoles(state);
    expect(state.showRoles).toBe(true);
    for (const p of hiddenSnapshot.players) {
      expect(visibleRole(hiddenSnapshot, state, p)).toBe(raw.players.find(r => r.id === p.id)!.role);
    }

    // End-of-game reveal always displays roles even when toggled back to hidden or never revealed.
    const neverRevealed = initialRoleVisibility(hiddenSnapshot);
    const hiddenAfterReveal = hideRolesVisually(state);
    for (const s of [neverRevealed, hiddenAfterReveal]) {
      for (const p of finishedSnapshot.players) {
        expect(visibleRole(finishedSnapshot, s, p)).toBe(raw.players.find(r => r.id === p.id)!.role as Role);
      }
    }
  });

  it("renders the live visibility control without leaking roles when hidden and displays roles when explicitly revealed", async () => {
    const raw = createGame("00000000-0000-4000-8000-000000000028", 1, 100, undefined, length => length - 1);

    const hiddenHtml = await renderLiveGameHtml({ seq: 1, game: publicGame(raw) });
    expect(hiddenHtml).toContain("Spectator role visibility");
    expect(hiddenHtml).toContain("Role hidden");
    expect(hiddenHtml).toContain('aria-pressed="true"');
    expect(hiddenHtml).toContain("Hidden roles are not sent to your browser until you choose to show them.");
    for (const role of ["Werewolf", "Seer", "Villager"]) {
      expect(hiddenHtml).not.toContain(role);
    }

    const revealedHtml = await renderLiveGameHtml({ seq: 1, game: publicGame(raw, { revealRoles: true }) });
    expect(revealedHtml).toContain("Spectator role visibility");
    expect(revealedHtml).not.toContain("Role hidden");
    expect(revealedHtml).toContain("Roles are revealed in this browser. Switching back to Hidden hides them visually only.");
    for (const role of ["Werewolf", "Seer", "Villager"]) {
      expect(revealedHtml).toContain(role);
    }

    const finishedHtml = await renderLiveGameHtml({ seq: 2, game: publicGame({ ...raw, status: "finished", winner: "Village" }) });
    expect(finishedHtml).not.toContain("Spectator role visibility");
    expect(finishedHtml).not.toContain("Role hidden");
    for (const role of ["Werewolf", "Seer", "Villager"]) {
      expect(finishedHtml).toContain(role);
    }
  });
});
