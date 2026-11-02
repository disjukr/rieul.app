import "../../src/theme.css";
import { render } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import type { AvailableShellInfo, FsEntry } from "../../src/protocol/generated/rpc.ts";
import { bunja, override } from "bunja";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { FilesTool } from "../../src/view/workbench/tool/files/index.tsx";
import { filesToolBunja } from "../../src/view/workbench/tool/files/state.ts";
import {
  explorerBunja,
  explorerNavigationBunja,
} from "../../src/state/explorer.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import { rpcSessionStub } from "../helpers/rpc-session.ts";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { machineModalBunja } from "../../src/state/machine-modal.ts";
import {
  workbenchBunja,
  workbenchPaneBunja,
  workbenchTabBunja,
} from "../../src/state/workbench.ts";
import { MachineIdContext } from "../../src/state/machine.tsx";
import { WorkbenchTabIdContext } from "../../src/state/workbench-context.ts";
import { encodeCbor } from "../../src/protocol/cbor.ts";
import {
  ProcId,
  encodeDaemonEnvironmentValue,
  encodeTrashItemsTableEventValue,
} from "../../src/protocol/generated/rpc.ts";
import {
  decodeReqResMessageSequencePrefix,
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../../src/protocol/wire.ts";
const params = new URLSearchParams(location.search);
const metrics = { home: 0, trash: 0, mutation: 0 };
Object.assign(window, { filesFixture: metrics });
const transport = {
  async createBidirectionalStream() {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      readable,
      writable: new WritableStream<Uint8Array>({
        write(bytes) {
          const message = decodeReqResMessageSequencePrefix(bytes).messages[0];
          if (!("procId" in message)) throw new Error("Missing procedure");
          let payload: Uint8Array;
          let kind = ReqResMessageKind.ResponseUnaryOk;
          if (message.procId === ProcId.GetDaemonEnvironment) {
            metrics.home++;
            payload = encodeCbor(
              encodeDaemonEnvironmentValue({
                homeDirectory:
                  params.has("empty") && metrics.home === 1
                    ? ""
                    : "/Users/fixture",
              }),
            );
          } else if (message.procId === ProcId.SubscribeTrashItems) {
            metrics.trash++;
            kind = ReqResMessageKind.ResponseStreamStart;
            payload = encodeCbor(
              encodeTrashItemsTableEventValue({
                type: "snapshot",
                rows: [
                  {
                    id: "opaque",
                    name: "discarded.txt",
                    originalParent: "",
                    readOnly: true,
                  },
                ],
              }),
            );
          } else {
            metrics.mutation++;
            throw new Error(`Unexpected Files RPC ${message.procId}`);
          }
          controller.enqueue(encodeReqResMessageSequence([{ kind, payload }]));
          if (kind === ReqResMessageKind.ResponseUnaryOk) controller.close();
        },
      }),
    };
  },
} as WebTransport;
const overrides = [
  override(rpcSessionBunja, () =>
    rpcSessionStub({ webTransport: async () => transport }),
  ),
  override(
    machineStoreBunja,
    () =>
      ({
        selected: () => ({ id: "fixture" }),
        selectedIsPaired: () => true,
      }) as never,
  ),
  override(machineModalBunja, () => ({}) as never),
  override(workbenchBunja, () => ({}) as never),
  override(workbenchPaneBunja, () => ({ paneId: "pane" }) as never),
  override(
    workbenchTabBunja,
    () =>
      ({
        tab: () => ({
          id: "tab",
          tool: "files",
          filesView: params.get("view") ?? "home",
        }),
      }) as never,
  ),
  override(filesToolBunja, () => {
    const [terminalShells] = createSignal<AvailableShellInfo[]>([]);
    return { terminalShells, defaultShell: createMemo(() => terminalShells()[0]) };
  }),
  override(explorerBunja, () => {
    const nav = bunja.use(explorerNavigationBunja);
    return {
      ...nav,
      visibleRows: createMemo<FsEntry[]>(() => []),
      selectedEntry: createMemo(() => undefined),
      refresh() {},
      refreshRevision: createSignal(0)[0],
    };
  }),
];
render(
  () => (
    <TestBunjaStoreProvider overrides={overrides}>
      <MachineIdContext value={() => "fixture"}>
        <WorkbenchTabIdContext value={() => "tab"}>
          <FilesTool />
        </WorkbenchTabIdContext>
      </MachineIdContext>
    </TestBunjaStoreProvider>
  ),
  document.getElementById("root")!,
);
