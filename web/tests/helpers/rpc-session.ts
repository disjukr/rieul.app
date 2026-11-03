import { createSignal } from "solid-js";
import type { Bunja } from "bunja";

import type { rpcSessionBunja } from "../../src/state/rpc-session.ts";
export type RpcSession =
  typeof rpcSessionBunja extends Bunja<infer Value> ? Value : never;
// Test-only defaults: unexpected methods fail instead of reaching a real daemon.
export function rpcSessionStub(values: Partial<RpcSession>): RpcSession {
  function unused(): never {
    throw new Error("Unexpected RPC method");
  }
  return {
    cluster: () => ({ supported: false, message: "fixture" }),
    refreshCluster: async () => {},
    closeRpcSession: unused,
    reconnect: unused,
    resetController: unused,
    startPairingSession: async () => unused(),
    completePairingSession: async () => unused(),
    webTransport: async () => unused(),
    connection: createSignal({ phase: "idle" as const })[0],
    daemonInfo: createSignal({ phase: "idle" as const })[0],
    daemonInstanceId: createSignal(undefined)[0],
    daemonServerTimeMs: createSignal(undefined)[0],
    daemonUptimeSeconds: createSignal(undefined)[0],
    ...values,
  };
}
