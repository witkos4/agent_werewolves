import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "../app/cloudflare-context";
import { gate } from "./gate";
import { handleSpikeRequest } from "./spike/routes";
import { handleGameRequest } from "./game/routes";

export { GameRoom } from "./game-room";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request, env, ctx) {
    const refused = await gate(request, env);
    if (refused) return refused;

    const game = await handleGameRequest(request, env);
    if (game) return game;

    const spike = await handleSpikeRequest(request, env);
    if (spike) return spike;

    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
