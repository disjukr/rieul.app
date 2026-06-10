import { createContext } from "react";
import { bunja } from "bunja";
import { createScopeFromContext, useBunja } from "bunja/react";
import { atom } from "jotai";
import { useAtomValue } from "jotai";
import { FileText, Loader2 } from "lucide-react";
import { FsEntry, readFile } from "../../../../../../protocol/rpc.ts";
import { displayName, formatSize } from "../../../../../../state/explorer.ts";
import { JotaiStoreScope } from "../../../../../../state/jotai-store.ts";
import { machineBunja } from "../../../../../../state/machine-store.ts";
import { detectFileViewerKind } from "./file-preview.ts";
import { HexFileViewer } from "./hex/index.tsx";
import { TextFileViewer } from "./text/index.tsx";
import type { FileSniffState } from "./types.ts";

const sniffByteCount = 4096;

export const FsEntryContext = createContext<FsEntry | undefined>(undefined);
const FsEntryScope = createScopeFromContext(FsEntryContext);

export const fileViewerBunja = bunja(() => {
  const machine = bunja.use(machineBunja);
  const fsEntry = requireFsEntry(bunja.use(FsEntryScope));
  const store = bunja.use(JotaiStoreScope);

  const stateAtom = atom<FileSniffState>({ phase: "sniffing" });

  bunja.effect(() => {
    const currentMachine = store.get(machine.machineAtom);
    if (!currentMachine) {
      store.set(stateAtom, {
        phase: "error",
        message: "No machine selected",
      });
      return;
    }

    let cancelled = false;
    store.set(stateAtom, { phase: "sniffing" });
    void (async () => {
      try {
        const bytes = await readFile(currentMachine, fsEntry.path, {
          offset: 0,
          length: sniffByteCount,
        });
        if (cancelled) return;
        store.set(stateAtom, {
          phase: "ready",
          initialBytes: bytes,
          kind: detectFileViewerKind(bytes),
        });
      } catch (err) {
        if (!cancelled) {
          store.set(stateAtom, {
            phase: "error",
            message: errorMessage(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  return {
    fsEntry,
    machineAtom: machine.machineAtom,
    stateAtom,
  };
});

export function FileViewer() {
  const viewer = useBunja(fileViewerBunja);
  const state = useAtomValue(viewer.stateAtom);
  const fsEntry = viewer.fsEntry;

  return (
    <section className="file-viewer">
      <header className="file-viewer-head">
        <div className="file-viewer-title">
          <FileText size={16} />
          <span>{displayName(fsEntry)}</span>
        </div>
        <span className="file-viewer-meta">
          {formatSize(fsEntry.size)}
        </span>
      </header>
      {state.phase === "sniffing"
        ? (
          <div className="file-viewer-status">
            <Loader2 size={18} className="spin" />
            <span>Inspecting file</span>
          </div>
        )
        : state.phase === "error"
        ? (
          <div className="file-viewer-status error">
            <span>{state.message}</span>
          </div>
        )
        : state.kind === "hex"
        ? <HexFileViewer />
        : <TextFileViewer />}
    </section>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireFsEntry(fsEntry: FsEntry | undefined): FsEntry {
  if (!fsEntry) throw new Error("FsEntry context is not provided.");
  return fsEntry;
}
