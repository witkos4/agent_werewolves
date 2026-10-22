import { handleSpikeRequest } from "../workers/spike/routes";

export { GameRoom } from "../workers/game-room";

export default {
  async fetch(request, env) {
    return (await handleSpikeRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
