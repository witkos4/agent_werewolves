import type { PublicGame, Role } from "../workers/game/engine";
import type { Snapshot } from "../workers/game/runtime";

/** Same-origin request header required for cookie-authenticated browser role reveal. */
export const ROLE_REVEAL_HEADER = "X-Spectator-Role-Reveal";

export type RoleMap = Record<string, Role>;

export type RoleVisibilityState = {
  /** Whether roles are currently shown in the live spectator UI. */
  showRoles: boolean;
  /** Whether this browser has received hidden roles for this game at any point. */
  hasRevealed: boolean;
  /** Cached authoritative roles once explicitly revealed (roles never change mid-game). */
  revealedRoles: RoleMap | null;
};

/** Extracts a complete player-id -> role map, or null if any player's role is absent. */
export function extractRoles(game: PublicGame): RoleMap | null {
  if (!game.players.length || game.players.some(p => !p.role)) return null;
  return Object.fromEntries(game.players.map(p => [p.id, p.role!]));
}

/** Initial live visibility state: always starts hidden until the spectator chooses Shown. */
export function initialRoleVisibility(): RoleVisibilityState {
  return { showRoles: false, hasRevealed: false, revealedRoles: null };
}

/** Applies an explicit reveal response; permanently marks `hasRevealed` for this view. */
export function applyRevealedRoles(roles: RoleMap): RoleVisibilityState {
  return { showRoles: true, hasRevealed: true, revealedRoles: roles };
}

/** Switches back to visually hidden mode without claiming prior data can be made secret again. */
export function hideRolesVisually(state: RoleVisibilityState): RoleVisibilityState {
  return { ...state, showRoles: false };
}

/** Re-shows already-revealed roles without another network request. */
export function showCachedRoles(state: RoleVisibilityState): RoleVisibilityState {
  return state.revealedRoles ? { ...state, showRoles: true } : state;
}

/**
 * Role to render for one seat:
 * - Finished games always reveal every role (preserving end-of-game reveal).
 * - Running games show a role only while the spectator has chosen shown mode.
 */
export function visibleRole(
  game: Pick<PublicGame, "status">,
  state: RoleVisibilityState,
  player: PublicGame["players"][number],
): Role | null {
  if (game.status === "finished") return player.role ?? state.revealedRoles?.[player.id] ?? null;
  if (!state.showRoles) return null;
  return player.role ?? state.revealedRoles?.[player.id] ?? null;
}

/** Honest status note for the current live role visibility mode. */
export function roleVisibilityNote(state: RoleVisibilityState): string {
  if (state.showRoles) {
    return "Roles are revealed in this browser. Switching back to Hidden hides them visually only.";
  }
  if (state.hasRevealed) {
    return "Roles are hidden visually only; roles already revealed to this browser cannot be made secret again.";
  }
  return "Hidden roles are not sent to your browser until you choose to show them.";
}

export type RoleRevealControllerDeps = {
  gameId: string;
  getGameStatus: () => PublicGame["status"];
  getVisibility: () => RoleVisibilityState;
  isLoading: () => boolean;
  setVisibility: (update: (prev: RoleVisibilityState) => RoleVisibilityState) => void;
  setLoadingRoles: (loading: boolean) => void;
  setRevealError: (error: string | null) => void;
  onSignIn: () => void;
  onTerminalSnapshot: (game: PublicGame) => void;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
};

/**
 * Shared action handlers for the live Shown/Hidden buttons.
 * Sends an explicit same-origin header that browser navigation cannot set.
 */
export function createRoleRevealActions(deps: RoleRevealControllerDeps) {
  let inflight: AbortController | null = null;

  async function showRoles(): Promise<void> {
    const current = deps.getVisibility();
    if (current.showRoles || deps.isLoading() || deps.getGameStatus() !== "running") return;
    deps.setRevealError(null);
    if (current.revealedRoles) {
      deps.setVisibility(showCachedRoles);
      return;
    }
    const controller = new AbortController();
    inflight?.abort();
    inflight = controller;
    deps.setLoadingRoles(true);
    try {
      const fetcher = deps.fetcher ?? fetch;
      const response = await fetcher(`/api/games/${deps.gameId}?roles=shown`, {
        cache: "no-store",
        headers: { [ROLE_REVEAL_HEADER]: "shown" },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 404) {
        deps.onSignIn();
        return;
      }
      if (!response.ok) throw new Error("reveal_failed");
      const snapshot = await response.json() as Snapshot;
      if (controller.signal.aborted) return;
      const roles = extractRoles(snapshot.game);
      if (!roles) throw new Error("missing_roles");
      deps.setVisibility(() => applyRevealedRoles(roles));
      if (snapshot.game.status !== "running") deps.onTerminalSnapshot(snapshot.game);
    } catch {
      if (!controller.signal.aborted) deps.setRevealError("Could not load roles. Try again.");
    } finally {
      if (inflight === controller) {
        inflight = null;
        deps.setLoadingRoles(false);
      }
    }
  }

  function hideRoles(): void {
    inflight?.abort();
    inflight = null;
    deps.setLoadingRoles(false);
    deps.setRevealError(null);
    deps.setVisibility(hideRolesVisually);
  }

  function abort(): void {
    inflight?.abort();
    inflight = null;
  }

  return { showRoles, hideRoles, abort };
}
