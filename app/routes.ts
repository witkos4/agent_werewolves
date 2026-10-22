import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("healthz", "routes/healthz.ts"),
  route("spike/:gameId", "routes/spike.$gameId.tsx"),
] satisfies RouteConfig;
