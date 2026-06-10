import { useContext, useEffect, useState } from "react";
import { useBunja } from "bunja/react";
import { useAtomValue } from "jotai";
import { readFile } from "../../../../../../../protocol/rpc.ts";
import type { FsEntry } from "../../../../../../../protocol/rpc.ts";
import { FilesActionsContext, requireFilesActions } from "../../../context.tsx";
import { FileOpenPrompt } from "../file-open-prompt.tsx";
import { decodeHexFilePreview } from "../file-preview.ts";
import { fileViewerBunja } from "../index.tsx";
import type { FileReadState } from "../types.ts";

const inlineOpenLimitBytes = 1024 * 1024;

export function HexFileViewer() {
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const viewer = useBunja(fileViewerBunja);
  const fsEntry = viewer.fsEntry;
  const sniffState = useAtomValue(viewer.stateAtom);
  const machine = useAtomValue(viewer.machineAtom);
  const requiresConfirmation = fsEntry.size === undefined ||
    fsEntry.size > inlineOpenLimitBytes;
  const [confirmedFsEntryPath, setConfirmedFsEntryPath] = useState<
    string | undefined
  >();
  const confirmed = !requiresConfirmation ||
    confirmedFsEntryPath === fsEntry.path;
  const [state, setState] = useState<FileReadState>({ phase: "loading" });

  useEffect(() => {
    if (!confirmed || !machine || sniffState.phase !== "ready") return;

    let cancelled = false;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const bytes = hasCompleteInitialBytes(fsEntry, sniffState.initialBytes)
          ? sniffState.initialBytes
          : await readFile(machine, fsEntry.path);
        if (cancelled) return;
        setState({
          phase: "ready",
          text: decodeHexFilePreview(bytes),
        });
      } catch (err) {
        if (!cancelled) {
          setState({
            phase: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [confirmed, fsEntry, fsEntry.path, machine, sniffState]);

  if (!machine) {
    return (
      <div className="file-viewer-status error">
        <span>No machine selected</span>
      </div>
    );
  }

  if (sniffState.phase !== "ready") return null;

  if (!confirmed) {
    return (
      <FileOpenPrompt
        onCancel={actions.goBack}
        onConfirm={() => setConfirmedFsEntryPath(fsEntry.path)}
        viewerLabel="hex viewer"
      />
    );
  }

  if (state.phase === "loading") {
    return (
      <div className="file-viewer-status">
        <span>Loading bytes</span>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="file-viewer-status error">
        <span>{state.message}</span>
      </div>
    );
  }

  return <pre className="file-content binary">{state.text}</pre>;
}

function hasCompleteInitialBytes(
  fsEntry: FsEntry,
  initialBytes: Uint8Array,
): boolean {
  return fsEntry.size !== undefined && fsEntry.size <= initialBytes.byteLength;
}
