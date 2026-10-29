import { gate } from "../workers/gate";
import { handleSpikeRequest } from "../workers/spike/routes";
import { handleGameRequest } from "../workers/game/routes";

export { GameRoom } from "../workers/game-room";

export default {
  async fetch(request, env) {
    const refused = await gate(request, env);
    if (refused) return refused;
    return (await handleGameRequest(request, env)) ?? (await handleSpikeRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
