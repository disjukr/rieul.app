import {
  createContext,
  createSignal,
  createMemo,
  untrack,
  type Accessor,
} from "solid-js";
import { bunja } from "bunja";
import { createScopeFromContext } from "bunja/solid";
import {
  type FsEntry,
  FsEntryKind,
} from "../../../../../../protocol/generated/rpc.ts";
import { fileViewerSelectedImplStorageKey } from "../../../../../../state/file-viewer.ts";
import { machineBunja } from "../../../../../../state/machine-store.ts";
import { rpcSessionBunja } from "../../../../../../state/rpc-session.ts";
import { WorkbenchTabIdScope } from "../../../../../../state/workbench-scopes.ts";
import { type FileViewerImplId, isFileViewerImpl } from "./impl/index.ts";
import { detectFileViewerImpl } from "./impl-detector/index.ts";
type FileViewerState =
  | {
      phase: "detecting";
    }
  | {
      phase: "error";
      message: string;
    }
  | {
      phase: "ready";
      initialBytes: Uint8Array;
      impl: FileViewerImplId;
    };
export const FsEntryContext = createContext<Accessor<FsEntry | undefined>>();
export const FsEntryPathContext = createContext<Accessor<string | undefined>>();
const FsEntryScope = createScopeFromContext(FsEntryContext);
export const FsEntryPathScope = createScopeFromContext(FsEntryPathContext);
export const fileViewerBunja = bunja(() => {
  const machine = bunja.use(machineBunja);
  const rpcSession = bunja.use(rpcSessionBunja);
  const tabId = requireWorkbenchTabId(bunja.use(WorkbenchTabIdScope));
  const fsEntryContext = bunja.use(FsEntryScope);
  const fsEntryPath = requireFsEntryPath(
    bunja.use(FsEntryPathScope) ?? fsEntryContext?.path,
  );
  const fsEntry =
    fsEntryContext?.path === fsEntryPath
      ? fsEntryContext
      : fsEntryFromPath(fsEntryPath);
  const [state, setState] = createSignal<FileViewerState>({
    phase: "detecting",
  });
  const storageKey = fileViewerSelectedImplStorageKey(
    machine.machineId,
    tabId,
    fsEntry.path,
  );
  let savedImpl: FileViewerImplId | undefined;
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
    const raw = storage?.getItem(storageKey);
    if (raw !== null && raw !== undefined) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string" && isFileViewerImpl(parsed))
        savedImpl = parsed;
    }
  } catch {
    /* Retain detected viewer when persisted preferences are unavailable. */
  }
  const [selectedImpl, setSelectedImpl] = createSignal(savedImpl);
  const impl = createMemo(() => {
    const selected = selectedImpl();
    if (selected) return selected;
    const current = state();
    return current.phase === "ready" ? current.impl : undefined;
  });
  function setImpl(value: FileViewerImplId) {
    setSelectedImpl(value);
    storage?.setItem(storageKey, JSON.stringify(value));
  }
  bunja.effect(() => {
    function onStorage(event: StorageEvent) {
      if (
        event.key !== storageKey ||
        (event.storageArea && event.storageArea !== storage)
      )
        return;
      let value: FileViewerImplId | undefined;
      try {
        const parsed: unknown =
          event.newValue === null ? undefined : JSON.parse(event.newValue);
        if (typeof parsed === "string" && isFileViewerImpl(parsed))
          value = parsed;
      } catch {
        /* Invalid external preference falls back to detection. */
      }
      setSelectedImpl(value);
    }
    globalThis.addEventListener?.("storage", onStorage);
    return () => globalThis.removeEventListener?.("storage", onStorage);
  });
  bunja.effect(() => {
    const currentMachine = untrack(machine.machine);
    let cancelled = false;
    void (async () => {
      const transport = await rpcSession.webTransport();
      if (cancelled) return;
      const result = await detectFileViewerImpl(
        currentMachine,
        fsEntry,
        transport,
      );
      if (cancelled) return;
      setState({
        phase: "ready",
        initialBytes: result.initialBytes,
        impl: result.impl,
      });
    })().catch((error: unknown) => {
      if (!cancelled) {
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  });
  return {
    fsEntry,
    impl,
    setImpl,
    machine: machine.machine,
    state,
    tabId,
    webTransport: rpcSession.webTransport,
  };
});
export function requireFsEntry(
  fsEntry: Accessor<FsEntry | undefined>,
): Accessor<FsEntry> {
  return () => {
    const value = fsEntry();
    if (!value) throw new Error("FsEntry context is not provided.");
    return value;
  };
}
function requireFsEntryPath(path: string | undefined): string {
  if (!path) throw new Error("FsEntry path context is not provided.");
  return path;
}
function requireWorkbenchTabId(tabId: string | undefined): string {
  if (!tabId) throw new Error("Workbench tab id context is not provided.");
  return tabId;
}
function fsEntryFromPath(path: string): FsEntry {
  return {
    kind: FsEntryKind.File,
    name: fileBasename(path),
    path,
    readonly: false,
  };
}
function fileBasename(path: string): string {
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(slashIndex + 1) || path;
}
