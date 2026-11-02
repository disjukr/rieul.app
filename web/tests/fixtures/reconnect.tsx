// Browser integration fixture: production RPC controller/protocol, synthetic transports only.
import { createRoot, createSignal } from "solid-js";
import { render } from "@solidjs/web";
import { createBunjaStore, createReadScopeFn } from "bunja";
import { rpcSessionBunja } from "../../src/state/rpc-session";
import {
  MachineIdScope,
  MachineBaseUrlScope,
} from "../../src/state/machine-scopes";
import { MachineStorageScope } from "../../src/state/machine-storage";
import { encodeCbor } from "../../src/protocol/cbor";
import { encodeDaemonInfoValue } from "../../src/protocol/generated/rpc";
import {
  decodeDatagramMessage,
  encodeDatagramMessage,
  encodeReqResMessageSequence,
  ReqResMessageKind,
  DatagramMessageKind,
} from "../../src/protocol/wire";
const [attempts, setAttempts] = createSignal(0);
const instances: Fake[] = [];
class Fake {
  ready = Promise.resolve();
  ended = Promise.withResolvers<WebTransportCloseInfo>();
  closed = this.ended.promise;
  reader!: ReadableStreamDefaultController<Uint8Array>;
  isClosed = false;
  silent = false;
  datagrams = {
    readable: new ReadableStream<Uint8Array>({
      start: (c) => {
        this.reader = c;
      },
      cancel: () => {
        this.isClosed = true;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write: (bytes) => {
        const m = decodeDatagramMessage(bytes);
        if (
          !this.silent &&
          !this.isClosed &&
          m.kind === DatagramMessageKind.Ping
        )
          this.reader.enqueue(
            encodeDatagramMessage({
              kind: DatagramMessageKind.Pong,
              pingId: m.pingId,
            }),
          );
      },
    }),
  };
  constructor() {
    instances.push(this);
    setAttempts((n) => n + 1);
  }
  close() {
    if (!this.isClosed) {
      this.isClosed = true;
      this.reader.close();
    }
    this.ended.resolve({});
  }
  async createBidirectionalStream() {
    return {
      writable: new WritableStream<Uint8Array>(),
      readable: new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(
            encodeReqResMessageSequence([
              {
                kind: ReqResMessageKind.ResponseUnaryOk,
                payload: encodeCbor(
                  encodeDaemonInfoValue({
                    instanceId: `daemon-${attempts()}`,
                    version: "fixture",
                    os: "fixture",
                    supportedProcIds: [],
                    startedAtMs: 0,
                    serverTimeMs: 0,
                  }),
                ),
              },
            ]),
          );
          c.close();
        },
      }),
    };
  }
}
Object.defineProperty(window, "WebTransport", {
  configurable: true,
  value: Fake,
});
const store = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
const storage = {
  getItem: (key: string) =>
    key === "rieul.machines.v1"
      ? JSON.stringify([
          {
            id: "fixture",
            name: "fixture",
            baseUrl: "https://fixture.invalid",
          },
        ])
      : null,
  setItem() {},
  removeItem() {},
};
const read = createReadScopeFn(
  [
    [MachineIdScope, "fixture"],
    [MachineBaseUrlScope, "https://fixture.invalid"],
    [MachineStorageScope, storage],
  ],
  () => undefined as never,
);
const entry = store.get(rpcSessionBunja, read);
entry.mount();
render(
  () => (
    <>
      <output aria-label="Connection">{entry.value.connection().phase}</output>
      <output aria-label="Attempts">{attempts()}</output>
      <output aria-label="Instance">{entry.value.daemonInstanceId()}</output>
      <button onClick={() => instances.at(-1)!.close()}>Daemon restart</button>
      <button
        onClick={() => {
          instances.at(-1)!.silent = true;
        }}
      >
        Drop packets
      </button>
      <button onClick={() => entry.value.closeRpcSession()}>Disconnect</button>
      <button onClick={() => window.dispatchEvent(new Event("online"))}>
        Online
      </button>
    </>
  ),
  document.getElementById("root")!,
);
