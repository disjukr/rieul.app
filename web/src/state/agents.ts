import { createAgentsBunja } from "./agents-model.ts";
import { rpcSessionBunja } from "./rpc-session.ts";

export { type AgentCatalogPhase, agentSessionTitle } from "./agents-model.ts";
export const agentsBunja = createAgentsBunja(rpcSessionBunja);
