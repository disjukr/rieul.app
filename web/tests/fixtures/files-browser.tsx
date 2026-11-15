import "../../src/theme.css";
import "../../src/solid/scopes.ts";
import { WorkbenchPaneLayout } from "../../src/view/workbench/pane-layout/index.tsx";
import { terminalShellsBunja } from "../../src/state/terminal-shells.ts";
import {
  fileViewerBunja,
  FsEntryPathScope,
} from "../../src/view/workbench/tool/files/content/file-viewer/state.tsx";
import type { FileViewerImplId } from "../../src/view/workbench/tool/files/content/file-viewer/impl/index.ts";
import { WorkbenchTabIdScope } from "../../src/state/workbench-scopes.ts";
import { FsEntryKind } from "../../src/protocol/generated/rpc.ts";
const home =
  "/Users/fixture/deeply-nested-project-directory/another-long-directory";
const text = new TextEncoder().encode("Synthetic file contents\n");
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);
const entries: FsEntry[] = [
  {
    name: "nested-folder-with-a-long-name",
    path: `${home}/nested-folder-with-a-long-name`,
    kind: FsEntryKind.Directory,
    readonly: false,
  },
  ...[
    "a-very-long-synthetic-filename-for-mobile-layout.txt",
    "fixture.png",
    "binary.bin",
  ].map((name) => ({
    name,
    path: `${home}/${name}`,
    kind: FsEntryKind.File,
    readonly: false,
    size: name.endsWith(".png") ? png.length : text.length,
  })),
];
if (!localStorage.getItem("rieul.workbench.fixture.v1"))
  localStorage.setItem(
    "rieul.workbench.fixture.v1",
    JSON.stringify({
      activePaneId: "pane",
      panes: [
        {
          id: "pane",
          activeTabId: "tab",
          tabs: [
            { id: "tab", tool: "files", title: "Home", filesView: "home" },
          ],
        },
      ],
      layout: {
        rootId: "root",
        nodes: { root: { id: "root", type: "leaf", paneId: "pane" } },
      },
    }),
  );

import { render } from "@solidjs/web";
import { createMemo, createSignal } from "solid-js";
import type {
  AvailableShellInfo,
  FsEntry,
} from "../../src/protocol/generated/rpc.ts";
import { bunja, override } from "bunja";
import { TestBunjaStoreProvider } from "./bunja-store.tsx";
import { filesToolBunja } from "../../src/view/workbench/tool/files/state.ts";
import {
  explorerBunja,
  explorerNavigationBunja,
} from "../../src/state/explorer.ts";
import { rpcSessionBunja } from "../../src/state/rpc-session.ts";
import { rpcSessionStub } from "../helpers/rpc-session.ts";
import { machineStoreBunja } from "../../src/state/machine-store.ts";
import { machineModalBunja } from "../../src/state/machine-modal.ts";
import { MachineIdContext } from "../../src/state/machine.tsx";
import { encodeCbor } from "../../src/protocol/cbor.ts";
import {
  ProcId,
  encodeDaemonEnvironmentValue,
  encodeReadFileChunkValue,
} from "../../src/protocol/generated/rpc.ts";
import {
  decodeReqResMessageSequencePrefix,
  encodeReqResMessageSequence,
  ReqResMessageKind,
} from "../../src/protocol/wire.ts";
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
            payload = encodeCbor(
              encodeDaemonEnvironmentValue({ homeDirectory: home }),
            );
          } else if (message.procId === ProcId.ReadFile) {
            kind = ReqResMessageKind.ResponseStreamStart;
            payload = encodeCbor(
              encodeReadFileChunkValue({ offset: 0, bytes: text }),
            );
          } else {
            throw new Error(`Unexpected Files RPC ${message.procId}`);
          }
          controller.enqueue(encodeReqResMessageSequence([{ kind, payload }]));
          controller.close();
        },
      }),
    };
  },
} as WebTransport;
const overrides = [
  override(fileViewerBunja, () => {
    const path = bunja.use(FsEntryPathScope);
    const tabId = bunja.use(WorkbenchTabIdScope)!;
    const fsEntry = entries.find((entry) => entry.path === path)!;
    const initialImpl: FileViewerImplId = path?.endsWith(".png")
      ? "image"
      : path?.endsWith(".bin")
        ? "hex"
        : "text";
    const [impl, setImpl] = createSignal<FileViewerImplId | undefined>(
      initialImpl,
    );
    return {
      fsEntry,
      impl,
      setImpl,
      tabId,
      machine: createSignal({
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.invalid",
      })[0],
      state: createSignal({
        phase: "ready" as const,
        initialBytes: initialImpl === "image" ? png : text,
        impl: initialImpl,
      })[0],
      webTransport: async () => transport,
    };
  }),
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

  override(terminalShellsBunja, () => {
    const [terminalShells] = createSignal<AvailableShellInfo[]>([]);
    return {
      terminalShells,
      defaultShell: createMemo(() => terminalShells()[0]),
    };
  }),
  override(filesToolBunja, () => {
    const [terminalShells] = createSignal<AvailableShellInfo[]>([]);
    return {
      terminalShells,
      defaultShell: createMemo(() => terminalShells()[0]),
    };
  }),
  override(explorerBunja, () => {
    const nav = bunja.use(explorerNavigationBunja);
    return {
      ...nav,
      visibleRows: createMemo<FsEntry[]>(() =>
        nav.currentPath() === home ? entries : [],
      ),
      selectedEntry: createMemo(() =>
        entries.find((entry) => entry.path === nav.selectedPath()),
      ),
      refresh() {},
      refreshRevision: createSignal(0)[0],
    };
  }),
];
render(
  () => (
    <TestBunjaStoreProvider overrides={overrides}>
      <MachineIdContext value={() => "fixture"}>
        <main style={{ height: "100dvh", display: "grid", "min-width": "0" }}>
          <WorkbenchPaneLayout />
        </main>
      </MachineIdContext>
    </TestBunjaStoreProvider>
  ),
  document.getElementById("root")!,
);
