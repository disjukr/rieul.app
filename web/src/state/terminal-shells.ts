import { createTerminalShellsBunja } from "./terminal-shells-model.ts";
import { rpcSessionBunja } from "./rpc-session.ts";

export const terminalShellsBunja = createTerminalShellsBunja(rpcSessionBunja);
