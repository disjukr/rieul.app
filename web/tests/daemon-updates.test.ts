import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { atom, createStore } from "jotai/vanilla";
import { JotaiStoreScope } from "../src/state/jotai-store.ts";
import * as client from "../src/protocol/generated/client.ts";
import { ProcId, UpdatePhase, UpdateAction, type UpdateStatus, type DaemonInfo } from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let getStatus: typeof client.getUpdateStatus;
let request: typeof client.requestUpdate;
mock.module("../src/protocol/generated/client.ts", { namedExports: { ...client,
  getUpdateStatus: (...args: Parameters<typeof getStatus>) => getStatus(...args),
  requestUpdate: (...args: Parameters<typeof request>) => request(...args),
}});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { daemonUpdatesBunja } = await import("../src/state/daemon-updates.ts");
const ready = (instanceId: string) => ({ phase: "ready" as const, receivedAtMs: 0, daemonInfo: {instanceId, version:"1.0.0", os:"macos", startedAtMs:0, serverTimeMs:0, supportedProcIds:[ProcId.GetUpdateStatus,ProcId.RequestUpdate]} satisfies DaemonInfo });
const status: UpdateStatus = { phase:UpdatePhase.Ready, currentVersion:"1.0.0", targetVersion:"1.0.1", canInstall:true };
async function flush() { for(let i=0;i<30;i++) await Promise.resolve(); }
function fixture(transport: () => Promise<WebTransport> = async () => ({} as WebTransport)) {
  const state=createStore(), info=atom(ready("first"));
  const store=createBunjaStore({overrides:[override(rpcSessionBunja,()=>rpcSessionStub({daemonInfoAtom:info,webTransport:transport}))]});
  const entry=store.get(daemonUpdatesBunja, createReadScopeFn([[JotaiStoreScope,state]],()=>undefined as never));
  const stop=entry.mount();
  return {state,info,value:entry.value,close(){stop();store.dispose();}};
}
test("manual action sends only fixed action and explicit confirmation; stale confirmation cannot affect replacement daemon",async()=>{
  const calls: unknown[]=[];
  getStatus=async()=>status; request=async(_transport,value)=>{calls.push(value);return status;};
  const f=fixture();
  try {
    await flush();
    const token=f.state.get(f.value.confirmationTokenAtom);
    await f.value.installConfirmed(token);
    assert.deepEqual(calls,[{action:UpdateAction.InstallConfirmed,confirmed:true}]);
    f.state.set(f.info,ready("replacement")); await flush();
    await f.value.installConfirmed(token);
    assert.equal(calls.length,1);
    await f.value.check();
    assert.deepEqual(calls[1],{action:UpdateAction.Check,confirmed:false});
  } finally {f.close();}
});
test("status response from old connection cannot replace new daemon state",async()=>{
  const pending: ReturnType<typeof Promise.withResolvers<UpdateStatus>>[]=[];
  getStatus=()=>{const p=Promise.withResolvers<UpdateStatus>();pending.push(p);return p.promise;};
  const f=fixture();
  try {
    await flush(); f.state.set(f.info,ready("replacement")); await flush();
    pending[1].resolve({...status,targetVersion:"2.0.0"}); await flush();
    pending[0].resolve(status); await flush();
    assert.equal(f.state.get(f.value.statusAtom)?.targetVersion,"2.0.0");
  } finally {f.close();}
});
test("reconnection while acquiring transport cancels the old installation request",async()=>{
  const pending=Promise.withResolvers<WebTransport>(); let hold=false,calls=0;
  getStatus=async()=>status; request=async()=>{calls++;return status;};
  const f=fixture(()=>hold?pending.promise:Promise.resolve({} as WebTransport));
  try {
    await flush(); hold=true;
    const action=f.value.installConfirmed(f.state.get(f.value.confirmationTokenAtom));
    f.state.set(f.info,ready("replacement"));
    pending.resolve({} as WebTransport); await action; await flush();
    assert.equal(calls,0);
  } finally {f.close();}
});
