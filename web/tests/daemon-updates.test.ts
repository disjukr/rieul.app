import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createBunjaStore, createReadScopeFn, override } from "bunja";
import { createRoot, createSignal, flush as flushSolid } from "solid-js";
import * as client from "../src/protocol/generated/client.ts";
import {
  ProcId,
  UpdatePhase,
  UpdateAction,
  type UpdateStatus,
  type DaemonInfo,
} from "../src/protocol/generated/rpc.ts";
import { rpcSessionStub } from "./helpers/rpc-session.ts";
let getStatus: typeof client.getUpdateStatus;
let request: typeof client.requestUpdate;
mock.module("../src/protocol/generated/client.ts", {
  namedExports: {
    ...client,
    getUpdateStatus: (...args: Parameters<typeof getStatus>) =>
      getStatus(...args),
    requestUpdate: (...args: Parameters<typeof request>) => request(...args),
  },
});
const { rpcSessionBunja } = await import("../src/state/rpc-session.ts");
const { daemonUpdatesBunja } = await import("../src/state/daemon-updates.ts");
const ready = (instanceId: string) => ({
  phase: "ready" as const,
  receivedAtMs: 0,
  daemonInfo: {
    instanceId,
    version: "1.0.0",
    os: "macos",
    startedAtMs: 0,
    serverTimeMs: 0,
    supportedProcIds: [ProcId.GetUpdateStatus, ProcId.RequestUpdate],
  } satisfies DaemonInfo,
});
const status: UpdateStatus = {
  phase: UpdatePhase.Ready,
  currentVersion: "1.0.0",
  targetVersion: "1.0.1",
  canInstall: true,
};
async function flush() {
  for (let i = 0; i < 30; i++) {
    flushSolid();
    await Promise.resolve();
  }
  flushSolid();
}
function fixture(
  transport: () => Promise<WebTransport> = async () => ({}) as WebTransport,
) {
  const [info, setInfo] = createSignal(ready("first"));
  const store = createBunjaStore({
    wrapInstance: (init) => createRoot(init),
    overrides: [
      override(rpcSessionBunja, () =>
        rpcSessionStub({ daemonInfo: info, webTransport: transport }),
      ),
    ],
  });
  const entry = store.get(
    daemonUpdatesBunja,
    createReadScopeFn([], () => undefined as never),
  );
  const stop = entry.mount();
  return {
    setInfo,
    value: entry.value,
    close() {
      stop();
      store.dispose();
    },
  };
}
test("manual action sends only fixed action and explicit confirmation; stale confirmation cannot affect replacement daemon", async () => {
  const calls: unknown[] = [];
  getStatus = async () => status;
  request = async (_transport, value) => {
    calls.push(value);
    return status;
  };
  const f = fixture();
  try {
    await flush();
    const token = f.value.confirmationToken();
    await f.value.installConfirmed(token);
    assert.deepEqual(calls, [
      { action: UpdateAction.InstallConfirmed, confirmed: true },
    ]);
    f.setInfo(ready("replacement"));
    await flush();
    await f.value.installConfirmed(token);
    assert.equal(calls.length, 1);
    await f.value.check();
    assert.deepEqual(calls[1], {
      action: UpdateAction.Check,
      confirmed: false,
    });
  } finally {
    f.close();
  }
});
test("status response from old connection cannot replace new daemon state", async () => {
  const pending: ReturnType<typeof Promise.withResolvers<UpdateStatus>>[] = [];
  getStatus = () => {
    const p = Promise.withResolvers<UpdateStatus>();
    pending.push(p);
    return p.promise;
  };
  const f = fixture();
  try {
    await flush();
    f.setInfo(ready("replacement"));
    await flush();
    pending[1].resolve({ ...status, targetVersion: "2.0.0" });
    await flush();
    pending[0].resolve(status);
    await flush();
    assert.equal(f.value.status()?.targetVersion, "2.0.0");
  } finally {
    f.close();
  }
});
test("reconnection while acquiring transport cancels the old installation request", async () => {
  const pending = Promise.withResolvers<WebTransport>();
  let hold = false,
    calls = 0;
  getStatus = async () => status;
  request = async () => {
    calls++;
    return status;
  };
  const f = fixture(() =>
    hold ? pending.promise : Promise.resolve({} as WebTransport),
  );
  try {
    await flush();
    hold = true;
    const action = f.value.installConfirmed(f.value.confirmationToken());
    f.setInfo(ready("replacement"));
    await flush();
    pending.resolve({} as WebTransport);
    await action;
    await flush();
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});

test("two installation requests in one Solid turn dispatch only once", async () => {
  const pending = Promise.withResolvers<UpdateStatus>();
  let calls = 0;
  getStatus = async () => status;
  request = async () => {
    calls++;
    return pending.promise;
  };
  const f = fixture();
  try {
    await flush();
    const token = f.value.confirmationToken();
    const first = f.value.installConfirmed(token);
    const second = f.value.installConfirmed(token);
    await flush();
    assert.equal(calls, 1);
    pending.resolve(status);
    await Promise.all([first, second]);
  } finally {
    f.close();
  }
});
test("final owner cleanup rejects a pending status response", async () => {
  const pending = Promise.withResolvers<UpdateStatus>();
  getStatus = () => pending.promise;
  const f = fixture();
  await flush();
  f.close();
  pending.resolve(status);
  await flush();
  assert.equal(f.value.status(), undefined);
});
