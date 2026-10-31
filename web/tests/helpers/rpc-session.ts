import type { Bunja } from "bunja";
import { atom } from "jotai/vanilla";
import type { rpcSessionBunja } from "../../src/state/rpc-session.ts";
export type RpcSession =
  typeof rpcSessionBunja extends Bunja<infer Value> ? Value : never;
// Test-only defaults: unexpected methods fail instead of reaching a real daemon.
export function rpcSessionStub(values: Partial<RpcSession>): RpcSession {
  function unused(): never {
    throw new Error("Unexpected RPC method");
  }
  return {
    closeRpcSession: unused,
    reconnect: unused,
    resetController: unused,
    startPairingSession: async () => unused(),
    completePairingSession: async () => unused(),
    webTransport: async () => unused(),
    connectionAtom: atom({ phase: "idle" as const }),
    daemonInfoAtom: atom({ phase: "idle" as const }),
    daemonInstanceIdAtom: atom<string | undefined>(undefined),
    daemonServerTimeMsAtom: atom<number | undefined>(undefined),
    daemonUptimeSecondsAtom: atom<number | undefined>(undefined),
    ...values,
  };
}
