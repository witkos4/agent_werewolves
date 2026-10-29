import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("healthz", "routes/healthz.ts"),
  route("login", "routes/login.tsx"),
  route("spike/:gameId", "routes/spike.$gameId.tsx"),
  route("games/:gameId", "routes/games.$gameId.tsx"),
] satisfies RouteConfig;
