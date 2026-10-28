import { createProcessesBunja } from "./processes-model.ts";
import { rpcSessionBunja } from "./rpc-session.ts";

export const processesBunja = createProcessesBunja(rpcSessionBunja);
