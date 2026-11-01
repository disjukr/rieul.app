import { style } from "../../../../../../../../zyzz.config.ts";
import { createMemo, createSignal, createEffect, useContext } from "solid-js";
import { useBunja } from "bunja/solid";

import type { FsEntry } from "../../../../../../../../protocol/generated/rpc.ts";
import { readFileBytes } from "../../read-file-bytes.ts";
import { formatSize } from "../../../../../../../../state/explorer.ts";
import {
  FilesActionsContext,
  requireFilesActions,
} from "../../../../context.tsx";
import { BigFileWarning } from "../../big-file-warning.tsx";
import { fileViewerBunja } from "../../state.tsx";
const inlineOpenLimitBytes = 1024 * 1024;

type FileReadState =
  | {
      phase: "loading";
    }
  | {
      phase: "ready";
      text: string;
    }
  | {
      phase: "error";
      message: string;
    };
const hexViewerName = "hex viewer";
export default function HexFileViewer() {
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const viewer = useBunja(fileViewerBunja);
  const fsEntry = createMemo(() => viewer().fsEntry);
  const viewerState = () => viewer().state();
  const machine = () => viewer().machine();
  const webTransport = createMemo(() => viewer().webTransport);
  const requiresConfirmation = createMemo(() => {
    const size = fsEntry().size;
    return size === undefined || size > inlineOpenLimitBytes;
  });
  const [confirmedFsEntryPath, setConfirmedFsEntryPath] = createSignal<
    string | undefined
  >();
  const confirmed = createMemo(
    () => !requiresConfirmation() || confirmedFsEntryPath() === fsEntry().path,
  );
  const [state, setState] = createSignal<FileReadState>({ phase: "loading" });
  const readyState = createMemo(() => {
    const value = state();
    return value.phase === "ready" ? value : undefined;
  });
  const errorMessage = createMemo(() => {
    const value = state();
    return value.phase === "error" ? value.message : "";
  });

  createEffect(
    () => ({
      confirmed: confirmed(),
      machine: machine(),
      viewerState: viewerState(),
      fsEntry: fsEntry(),
      webTransport: webTransport(),
    }),
    ({
      confirmed: currentConfirmed,
      machine: currentMachine,
      viewerState: currentViewerState,
      fsEntry: currentFsEntry,
      webTransport: currentWebTransport,
    }) => {
      if (
        !currentConfirmed ||
        !currentMachine ||
        currentViewerState.phase !== "ready"
      )
        return;
      let cancelled = false;
      setState({ phase: "loading" });
      void (async () => {
        try {
          const bytes = hasCompleteInitialBytes(
            currentFsEntry,
            currentViewerState.initialBytes,
          )
            ? currentViewerState.initialBytes
            : await readFileBytes(
                await currentWebTransport(),
                currentFsEntry.path,
              );
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
    },
  );
  return (
    <>
      {!machine() ? (
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>No machine selected</span>
        </div>
      ) : viewerState().phase !== "ready" ? null : !confirmed() ? (
        <BigFileWarning
          onCancel={actions().goBack}
          onConfirm={() => setConfirmedFsEntryPath(fsEntry().path)}
          viewerName={hexViewerName}
        />
      ) : state().phase === "loading" ? (
        <div {...styles.fileViewerStatus()}>
          <span>Loading bytes</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>{errorMessage()}</span>
        </div>
      ) : (
        <pre {...styles.fileContent()}>{readyState()!.text}</pre>
      )}
    </>
  );
}
function hasCompleteInitialBytes(
  fsEntry: FsEntry,
  initialBytes: Uint8Array,
): boolean {
  return fsEntry.size !== undefined && fsEntry.size <= initialBytes.byteLength;
}
function decodeHexFilePreview(bytes: Uint8Array): string {
  const previewLength = Math.min(bytes.length, 4096);
  const lines: string[] = [];
  for (let offset = 0; offset < previewLength; offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, previewLength));
    const hex = Array.from(chunk)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(chunk)
      .map((byte) =>
        byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
      )
      .join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (bytes.length > previewLength) {
    lines.push(`... ${formatSize(bytes.length - previewLength)} more`);
  }
  return lines.join("\n");
}

namespace styles {
  export const fileViewerStatus = style({
    minHeight: "0",
    minWidth: "0",
    display: "flex",
    selectors: {
      "&.error": {
        alignItems: "flex-start",
        justifyContent: "flex-start",
        overflow: "auto",
        padding: "14px",
        color: "rgb(180 35 24 / 1)",
      },
    },
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
  export const fileContent = style({
    overflowWrap: "normal",
    tabSize: 2,
    margin: "0",
    minHeight: "0",
    minWidth: "0",
    overflow: "auto",
    whiteSpace: "pre",
    backgroundColor: "rgb(255 255 255 / 1)",
    padding: "14px",
    fontSize: "13px",
    color: "rgb(32 36 45 / 1)",
    lineHeight: 1.55,
    fontFamily:
      'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
  });
}
