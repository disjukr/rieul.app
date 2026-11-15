import "../../src/theme.css";
import { render } from "@solidjs/web";
import { override, type Bunja } from "bunja";
import { createSignal } from "solid-js";

import { decodeCbor, encodeCbor } from "../../src/protocol/cbor.ts";
import {
  decodeSubscribeWindowDetailReqValue,
  encodeSubscribeWindowDetailErrorValue,
  encodeWindowDetailEventValue,
  encodeWindowsTableEventValue,
  ProcId,
  type WindowInfo,
} from "../../src/protocol/generated/rpc.ts";
import { RpcErrorKind } from "../../src/protocol/generated/wire.ts";
import {
  decodeReqResMessageSequence,
  encodeReqResMessageSequence,
  ReqResMessageKind,
  type ReqResMessage,
} from "../../src/protocol/wire.ts";
import { machineModalBunja } from "../../src/state/machine-modal.ts";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import {
  type WorkbenchTab,
  type WorkbenchWindowsTabConfig,
  workbenchPaneBunja,
  workbenchTabBunja,
} from "../../src/state/workbench.ts";
import { WindowsTool } from "../../src/view/workbench/tool/windows/index.tsx";
import { rpcSessionStub } from "../helpers/rpc-session.ts";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";

const windowWithPid: WindowInfo = {
  windowId: "opaque-epoch-fixture-a",
  processId: 4125,
};
const windowWithoutPid: WindowInfo = { windowId: "opaque-epoch-fixture-b" };
const titledWindow: WindowInfo = {
  windowId: "opaque-epoch-fixture-c",
  title: "Fixture editor",
};
const vanishedWindow: WindowInfo = {
  windowId: "opaque-epoch-fixture-stale",
  title: "Stale entry",
};
const rows = [windowWithPid, windowWithoutPid, titledWindow, vanishedWindow];

type Model<T> = T extends Bunja<infer Value> ? Value : never;
function Fixture() {
  const [cancelledLists, setCancelledLists] = createSignal(0);
  const [tab, setTab] = createSignal<WorkbenchTab>({
    id: "fixture",
    tool: "windows",
    title: "Windows",
  });
  let list: ReadableStreamDefaultController<Uint8Array> | undefined;
  let detail: ReadableStreamDefaultController<Uint8Array> | undefined;
  const transport = {
    async createBidirectionalStream() {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let procId: number;
      const readable = new ReadableStream<Uint8Array>({
        start: (value) => (controller = value),
        cancel: () => {
          if (procId === ProcId.SubscribeWindows) {
            if (list === controller) list = undefined;
            setCancelledLists((n) => n + 1);
          } else if (detail === controller) {
            detail = undefined;
          }
        },
      });
      return {
        readable,
        writable: new WritableStream<Uint8Array>({
          write(bytes) {
            const [request] = decodeReqResMessageSequence(bytes);
            procId = request!.procId!;
            const send = (event: ReqResMessage) =>
              controller.enqueue(encodeReqResMessageSequence([event]));
            if (procId === ProcId.SubscribeWindows) {
              list = controller;
              send({
                kind: ReqResMessageKind.ResponseStreamStart,
                payload: encodeCbor(
                  encodeWindowsTableEventValue({ type: "snapshot", rows }),
                ),
              });
            } else if (procId === ProcId.SubscribeWindowDetail) {
              const { windowId } = decodeSubscribeWindowDetailReqValue(
                decodeCbor(request!.payload!),
              );
              const info = rows.find((row) => row.windowId === windowId);
              if (!info || info === vanishedWindow) {
                send({
                  kind: ReqResMessageKind.ResponseStreamErrorEnd,
                  errorKind: RpcErrorKind.Method,
                  error: encodeCbor(
                    encodeSubscribeWindowDetailErrorValue({
                      type: "notFound",
                      message: "Unknown ID",
                    }),
                  ),
                });
                controller.close();
                return;
              }
              detail = controller;
              send({
                kind: ReqResMessageKind.ResponseStreamStart,
                payload: encodeCbor(
                  encodeWindowDetailEventValue({
                    type: "snapshot",
                    detail: {
                      info,
                      state: { visible: true },
                      bounds: { x: -132, y: 54, width: 480, height: 120 },
                    },
                  }),
                ),
              });
            } else {
              throw new Error(`Unexpected fixture procedure: ${procId}`);
            }
          },
        }),
      };
    },
  };
  const rpc = rpcSessionStub({
    daemonInfo: createSignal<
      ReturnType<Model<typeof rpcSessionBunja>["daemonInfo"]>
    >({
      phase: "ready",
      receivedAtMs: 0,
      daemonInfo: {
        instanceId: "fixture",
        version: "fixture",
        os: "macos",
        supportedProcIds: [
          ProcId.SubscribeWindows,
          ProcId.SubscribeWindowDetail,
        ],
        startedAtMs: 0,
        serverTimeMs: 0,
      },
    })[0],
    webTransport: async () => transport as unknown as WebTransport,
  });
  const changeDetail = (windowDetailId?: string, title = "Windows") =>
    setTab({ id: "fixture", tool: "windows", windowDetailId, title });

  return (
    <main
      style={{ height: "100vh", display: "flex", "flex-direction": "column" }}
    >
      <div>
        <button onClick={() => detail?.close()}>End detail stream</button>
        <button onClick={() => list?.close()}>End list stream</button>
        <button
          onClick={() => {
            detail?.enqueue(
              encodeReqResMessageSequence([
                {
                  kind: ReqResMessageKind.ResponseStreamChunk,
                  payload: encodeCbor(
                    encodeWindowDetailEventValue({ type: "closed" }),
                  ),
                },
              ]),
            );
            detail?.close();
          }}
        >
          Remove window
        </button>
        <output aria-label="Cancelled list count">{cancelledLists()}</output>
        <output aria-label="Tab title">{tab().title}</output>
      </div>
      <TestBunjaStoreProvider
        overrides={[
          override(
            machineModalBunja,
            () => ({}) as Model<typeof machineModalBunja>,
          ),
          override(
            machineStoreBunja,
            () =>
              ({
                selected: createSignal({
                  id: "fixture",
                  name: "Fixture",
                  baseUrl: "https://fixture.invalid",
                })[0],
                selectedIsPaired: createSignal(true)[0],
              }) as Model<typeof machineStoreBunja>,
          ),
          override(rpcSessionBunja, () => rpc),
          override(
            workbenchTabBunja,
            () =>
              ({
                tab,
                setWindowDetailId: changeDetail,
              }) as unknown as Model<typeof workbenchTabBunja>,
          ),
          override(
            workbenchPaneBunja,
            () =>
              ({
                addWindowsTab: (config?: WorkbenchWindowsTabConfig) =>
                  changeDetail(config?.windowDetailId, config?.title),
              }) as unknown as Model<typeof workbenchPaneBunja>,
          ),
        ]}
      >
        <WindowsTool />
      </TestBunjaStoreProvider>
    </main>
  );
}

render(() => <Fixture />, document.getElementById("root")!);
