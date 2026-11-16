import { gate } from "../workers/gate";
import { handleSpikeRequest } from "../workers/spike/routes";
import { handleGameRequest } from "../workers/game/routes";
import { handleBatchRequest } from "../workers/batch/routes";

export { GameRoom } from "../workers/game-room";
export { BatchRoom } from "../workers/batch-room";

export default {
  async fetch(request, env) {
    const refused = await gate(request, env);
    if (refused) return refused;
    return (await handleGameRequest(request, env)) ?? (await handleBatchRequest(request, env)) ?? (await handleSpikeRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
