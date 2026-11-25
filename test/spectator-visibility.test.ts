import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, MemoryRouter, RouterContextProvider, StaticRouterProvider, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueSession, SESSION_COOKIE } from "../app/access.server";
import { cloudflareContext } from "../app/cloudflare-context";
import GamePage, { LiveGameView, loader as gameLoader } from "../app/routes/games.$gameId";
import {
  applyRevealedRoles,
  createRoleRevealActions,
  extractRoles,
  hideRolesVisually,
  initialRoleVisibility,
  ROLE_REVEAL_HEADER,
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

async function cookieHeader() {
  const token = await issueSession(env.ACCESS_KEY, Date.now());
  return { Cookie: `${SESSION_COOKIE}=${token}` };
}

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

async function connectWs(id: string, query: string, extraHeaders: Record<string, string> = {}) {
  const response = await SELF.fetch(`https://example.test/api/games/${id}/ws?${query}`, {
    headers: { ...AUTH, Upgrade: "websocket", ...extraHeaders },
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

type ButtonElement = ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  "aria-pressed"?: boolean;
  disabled?: boolean;
}>;

/** Collects every <button> element in a React element tree. */
function findButtons(node: ReactNode, found: ButtonElement[] = []): ButtonElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  if (node.type === "button") found.push(node as ButtonElement);
  const props = node.props as { children?: ReactNode };
  if (props.children !== undefined) findButtons(props.children, found);
  return found;
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
  it("keeps browser navigation redacted even with ?roles=shown and requires explicit Shown header for cookie-authenticated snapshots", async () => {
    const { room, id } = await startLiveGame();
    const authoritative = await readGame(room);
    await stubVillageWin(room, "nav-secret-rationale");
    await runDurableObjectAlarm(room);

    // Page navigation with ?roles=shown stays redacted while the game is running.
    for (const path of [`/games/${id}`, `/games/${id}?roles=shown`, `/games/${id}?roles=hidden`, `/games/${id}?roles=true`]) {
      const page = await loadGamePage(path, id);
      expect(page.kind).toBe("live");
      if (page.kind !== "live") throw new Error("expected live");
      expectNoRoles(page.snapshot.game, JSON.stringify(page));
      expect(JSON.stringify(page)).not.toContain("nav-secret-rationale");
    }

    const cookie = await cookieHeader();
    // Cookie-authenticated browser GET with ?roles=shown alone (direct navigation) stays redacted.
    const navVariants: Record<string, string>[] = [
      cookie,
      { ...cookie, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
      { ...cookie, [ROLE_REVEAL_HEADER]: "shown", "Sec-Fetch-Mode": "navigate" },
      { ...cookie, [ROLE_REVEAL_HEADER]: "shown", Origin: "https://evil.test" },
      { ...cookie, [ROLE_REVEAL_HEADER]: "shown", "Sec-Fetch-Site": "cross-site" },
      { ...cookie, Authorization: "Bearer wrong-key-012345678901234567890123456789" },
    ];
    for (const headers of navVariants) {
      const response = await SELF.fetch(`https://example.test/api/games/${id}?roles=shown`, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const text = await response.text();
      expectNoRoles((JSON.parse(text) as Snapshot).game, text);
    }

    // Explicit same-origin request from the Shown control discloses roles to a cookie-authenticated browser.
    const browserReveal = await SELF.fetch(`https://example.test/api/games/${id}?roles=shown`, {
      headers: { ...cookie, [ROLE_REVEAL_HEADER]: "shown", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin" },
    });
    expect(browserReveal.status).toBe(200);
    expect(browserReveal.headers.get("Cache-Control")).toBe("no-store");
    const browserRevealText = await browserReveal.text();
    expectExactRoles((JSON.parse(browserRevealText) as Snapshot).game, authoritative);
    expect(browserRevealText).not.toContain("nav-secret-rationale");

    // Bearer-authenticated script GET with ?roles=shown still works without the browser header.
    const scriptReveal = await SELF.fetch(`https://example.test/api/games/${id}?roles=shown`, { headers: AUTH });
    expect(scriptReveal.status).toBe(200);
    const scriptRevealText = await scriptReveal.text();
    expectExactRoles((JSON.parse(scriptRevealText) as Snapshot).game, authoritative);
    expect(scriptRevealText).not.toContain("nav-secret-rationale");

    // End-of-game reveal still returns the full record with every role without ?roles=shown.
    await playToFinish(room, "nav-secret-rationale");
    const endedPage = await loadGamePage(`/games/${id}`, id);
    expect(endedPage.kind).toBe("record");
    if (endedPage.kind !== "record") throw new Error("expected record");
    expect(endedPage.record.players.map(p => [p.seat, p.role])).toEqual(authoritative.players.map(p => [p.id, p.role]));

    // Both cookie and bearer snapshot GETs reveal roles once finished without ?roles=shown.
    for (const headers of [cookie, AUTH]) {
      const endedSnapshot = await SELF.fetch(`https://example.test/api/games/${id}`, { headers });
      expect(endedSnapshot.status).toBe(200);
      expectExactRoles((await endedSnapshot.json() as Snapshot).game, authoritative);
    }
  });

  it("keeps hidden roles out of unrevealed snapshots and WebSocket events even while another spectator reveals", async () => {
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
    expect((await SELF.fetch(`https://example.test/api/games/${id}?roles=shown`, {
      headers: { [ROLE_REVEAL_HEADER]: "shown" },
    })).status).toBe(404);

    // Unrevealed, cross-origin, and revealed WebSockets connected concurrently to the same live room.
    const hiddenWs = await connectWs(id, "after=0");
    const explicitHiddenWs = await connectWs(id, "after=0&roles=hidden");
    const crossOriginWs = await connectWs(id, "after=0&roles=shown", { Origin: "https://evil.test" });
    const revealedWs = await connectWs(id, "after=0&roles=shown");

    await vi.waitFor(() => {
      expect(hiddenWs.raw).toHaveLength(1);
      expect(explicitHiddenWs.raw).toHaveLength(1);
      expect(crossOriginWs.raw).toHaveLength(1);
      expect(revealedWs.raw).toHaveLength(1);
    });

    // Backlog check: unrevealed and cross-origin sockets have no roles; revealed socket has exact roles.
    expectNoRoles(JSON.parse(hiddenWs.raw[0]).payload, hiddenWs.raw[0]);
    expectNoRoles(JSON.parse(explicitHiddenWs.raw[0]).payload, explicitHiddenWs.raw[0]);
    expectNoRoles(JSON.parse(crossOriginWs.raw[0]).payload, crossOriginWs.raw[0]);
    expectExactRoles(JSON.parse(revealedWs.raw[0]).payload, authoritative);

    // Advance one turn (Seer investigation): verify live broadcast isolation.
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => {
      expect(hiddenWs.raw).toHaveLength(2);
      expect(explicitHiddenWs.raw).toHaveLength(2);
      expect(crossOriginWs.raw).toHaveLength(2);
      expect(revealedWs.raw).toHaveLength(2);
    });
    expectNoRoles(JSON.parse(hiddenWs.raw[1]).payload, hiddenWs.raw[1]);
    expectNoRoles(JSON.parse(explicitHiddenWs.raw[1]).payload, explicitHiddenWs.raw[1]);
    expectNoRoles(JSON.parse(crossOriginWs.raw[1]).payload, crossOriginWs.raw[1]);
    expectExactRoles(JSON.parse(revealedWs.raw[1]).payload, authoritative);
    for (const msg of [hiddenWs.raw[1], explicitHiddenWs.raw[1], crossOriginWs.raw[1], revealedWs.raw[1]]) {
      expect(msg).not.toContain("ws-secret-rationale");
    }

    // Hibernate/evict the Durable Object: attachment-persisted reveal state must survive without leaking.
    await evictDurableObject(room);
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => {
      expect(hiddenWs.raw).toHaveLength(3);
      expect(explicitHiddenWs.raw).toHaveLength(3);
      expect(crossOriginWs.raw).toHaveLength(3);
      expect(revealedWs.raw).toHaveLength(3);
    });
    expectNoRoles(JSON.parse(hiddenWs.raw[2]).payload, hiddenWs.raw[2]);
    expectNoRoles(JSON.parse(explicitHiddenWs.raw[2]).payload, explicitHiddenWs.raw[2]);
    expectNoRoles(JSON.parse(crossOriginWs.raw[2]).payload, crossOriginWs.raw[2]);
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

    hiddenWs.ws.close();
    explicitHiddenWs.ws.close();
    crossOriginWs.ws.close();
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
});

describe("spectator role visibility UI interaction and rendering", () => {
  it("clicks Shown to trigger the explicit reveal request and render roles, then clicks Hidden to hide them visually with the prior-disclosure notice", async () => {
    const { room, id } = await startLiveGame();
    const authoritative = await readGame(room);
    await stubVillageWin(room, "interaction-secret-rationale");
    const cookie = await cookieHeader();

    // Load the live page just as a signed-in browser does (even with ?roles=shown in the URL).
    const page = await loadGamePage(`/games/${id}?roles=shown`, id);
    expect(page.kind).toBe("live");
    if (page.kind !== "live") throw new Error("expected live");

    let game = page.snapshot.game;
    let connection: "connecting" | "live" | "reconnecting" | "closed" | "sign-in" = "live";
    let visibility = initialRoleVisibility();
    let loadingRoles = false;
    let revealError: string | null = null;
    const requests: { url: string; headers: Headers; cache?: RequestCache }[] = [];

    const actions = createRoleRevealActions({
      gameId: id,
      getGameStatus: () => game.status,
      getVisibility: () => visibility,
      isLoading: () => loadingRoles,
      setVisibility: update => { visibility = update(visibility); },
      setLoadingRoles: loading => { loadingRoles = loading; },
      setRevealError: error => { revealError = error; },
      onSignIn: () => { connection = "sign-in"; },
      onTerminalSnapshot: terminal => { game = terminal; },
      fetcher: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({ url: input, headers: new Headers(headers), cache: init?.cache });
        headers.set("Cookie", cookie.Cookie);
        headers.set("Sec-Fetch-Mode", "cors");
        headers.set("Sec-Fetch-Site", "same-origin");
        return SELF.fetch(`https://example.test${input}`, { ...init, headers });
      },
    });

    function renderView() {
      const element = LiveGameView({
        game,
        connection,
        visibility,
        loadingRoles,
        revealError,
        onShowRoles: () => { void actions.showRoles(); },
        onHideRoles: () => { actions.hideRoles(); },
      });
      const buttons = findButtons(element);
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, element));
      return {
        html,
        hiddenButton: buttons.find(b => b.props.children === "Hidden")!,
        shownButton: buttons.find(b => b.props.children === "Shown")!,
      };
    }

    // 1. Initial live view: roles hidden, zero reveal requests made, no role names in HTML.
    const initial = renderView();
    expect(requests).toHaveLength(0);
    expect(initial.hiddenButton.props["aria-pressed"]).toBe(true);
    expect(initial.shownButton.props["aria-pressed"]).toBe(false);
    expect(initial.html).toContain("Role hidden");
    expect(initial.html).toContain("Hidden roles are not sent to your browser until you choose to show them.");
    for (const role of ["Werewolf", "Seer", "Villager"]) expect(initial.html).not.toContain(role);

    // 2. Click Shown button: sends explicit same-origin reveal request and renders every role.
    initial.shownButton.props.onClick!();
    await vi.waitFor(() => expect(visibility.showRoles).toBe(true));

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`/api/games/${id}?roles=shown`);
    expect(requests[0].cache).toBe("no-store");
    expect(requests[0].headers.get(ROLE_REVEAL_HEADER)).toBe("shown");
    expect(requests[0].headers.get("Authorization")).toBeNull();

    const shown = renderView();
    expect(shown.hiddenButton.props["aria-pressed"]).toBe(false);
    expect(shown.shownButton.props["aria-pressed"]).toBe(true);
    expect(shown.html).not.toContain("Role hidden");
    expect(shown.html).toContain("Roles are revealed in this browser. Switching back to Hidden hides them visually only.");
    for (const player of authoritative.players) expect(shown.html).toContain(player.role);

    // 3. Subsequent unrevealed live turn update keeps roles visible while in Shown mode.
    await runDurableObjectAlarm(room);
    const nextUnrevealed = (await room.getLiveSnapshot())!.game;
    expectNoRoles(nextUnrevealed, JSON.stringify(nextUnrevealed));
    game = nextUnrevealed;
    const afterTurn = renderView();
    expect(afterTurn.html).not.toContain("Role hidden");
    for (const player of authoritative.players) expect(afterTurn.html).toContain(player.role);

    // 4. Click Hidden button: hides roles visually and displays the prior-disclosure notice.
    afterTurn.hiddenButton.props.onClick!();
    const hiddenAgain = renderView();
    expect(hiddenAgain.hiddenButton.props["aria-pressed"]).toBe(true);
    expect(hiddenAgain.shownButton.props["aria-pressed"]).toBe(false);
    expect(hiddenAgain.html).toContain("Role hidden");
    expect(hiddenAgain.html).toContain("Roles are hidden visually only; roles already revealed to this browser cannot be made secret again.");
    for (const role of ["Werewolf", "Seer", "Villager"]) expect(hiddenAgain.html).not.toContain(role);

    // 5. Click Shown again: restores roles from browser state without a second network request.
    hiddenAgain.shownButton.props.onClick!();
    const reshown = renderView();
    expect(requests).toHaveLength(1);
    expect(reshown.shownButton.props["aria-pressed"]).toBe(true);
    expect(reshown.html).not.toContain("Role hidden");
    for (const player of authoritative.players) expect(reshown.html).toContain(player.role);
  });

  it("switches state cleanly and always reveals roles at game end regardless of prior toggle state", () => {
    const raw = createGame("ui-state", 1, 100, undefined, length => length - 1);
    const hiddenSnapshot = publicGame(raw);
    const revealedSnapshot = publicGame(raw, { revealRoles: true });
    const finishedSnapshot = publicGame({ ...raw, status: "finished", winner: "Village" });

    let state = initialRoleVisibility();
    expect(state).toEqual({ showRoles: false, hasRevealed: false, revealedRoles: null });
    expect(roleVisibilityNote(state)).toContain("not sent");
    for (const p of hiddenSnapshot.players) expect(visibleRole(hiddenSnapshot, state, p)).toBeNull();

    const roles = extractRoles(revealedSnapshot)!;
    state = applyRevealedRoles(roles);
    expect(state.showRoles).toBe(true);
    expect(state.hasRevealed).toBe(true);

    state = hideRolesVisually(state);
    expect(state.showRoles).toBe(false);
    expect(state.hasRevealed).toBe(true);
    expect(roleVisibilityNote(state)).toContain("cannot be made secret again");

    state = showCachedRoles(state);
    expect(state.showRoles).toBe(true);

    const neverRevealed = initialRoleVisibility();
    const hiddenAfterReveal = hideRolesVisually(state);
    for (const s of [neverRevealed, hiddenAfterReveal]) {
      for (const p of finishedSnapshot.players) {
        expect(visibleRole(finishedSnapshot, s, p)).toBe(raw.players.find(r => r.id === p.id)!.role as Role);
      }
    }
  });

  it("renders GamePage SSR redacted while running and reveals all roles without the live toggle once finished", async () => {
    const raw = createGame("00000000-0000-4000-8000-000000000028", 1, 100, undefined, length => length - 1);

    const hiddenHtml = await renderLiveGameHtml({ seq: 1, game: publicGame(raw) });
    expect(hiddenHtml).toContain("Spectator role visibility");
    expect(hiddenHtml).toContain("Role hidden");
    expect(hiddenHtml).toContain('aria-pressed="true"');
    expect(hiddenHtml).toContain("Hidden roles are not sent to your browser until you choose to show them.");
    for (const role of ["Werewolf", "Seer", "Villager"]) {
      expect(hiddenHtml).not.toContain(role);
    }

    const finishedHtml = await renderLiveGameHtml({ seq: 2, game: publicGame({ ...raw, status: "finished", winner: "Village" }) });
    expect(finishedHtml).not.toContain("Spectator role visibility");
    expect(finishedHtml).not.toContain("Role hidden");
    for (const role of ["Werewolf", "Seer", "Villager"]) {
      expect(finishedHtml).toContain(role);
    }
  });
});
