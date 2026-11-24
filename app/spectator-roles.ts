import type { PublicGame, Role } from "../workers/game/engine";

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

/** Initial live visibility state derived from the loader's snapshot. */
export function initialRoleVisibility(game: PublicGame): RoleVisibilityState {
  const roles = game.status === "running" ? extractRoles(game) : null;
  return roles
    ? { showRoles: true, hasRevealed: true, revealedRoles: roles }
    : { showRoles: false, hasRevealed: false, revealedRoles: null };
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
