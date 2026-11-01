import { style } from "../../../../../../../../zyzz.config.ts";
import {
  onCleanup,
  createMemo,
  createSignal,
  createEffect,
  useContext,
  lazy,
  Loading,
} from "solid-js";
import { useBunja } from "bunja/solid";

import { writeFile } from "../../../../../../../../protocol/generated/client.ts";
import {
  type FsEntry,
  WriteFileMode,
} from "../../../../../../../../protocol/generated/rpc.ts";
import { workbenchTabBunja } from "../../../../../../../../state/workbench.ts";
import {
  FilesActionsContext,
  requireFilesActions,
} from "../../../../context.tsx";
import { BigFileWarning } from "../../big-file-warning.tsx";
import { readFileBytes } from "../../read-file-bytes.ts";
import {
  fileViewerBunja,
  FsEntryContext,
  requireFsEntry,
} from "../../state.tsx";
const MonacoTextViewer = lazy(async () => {
  const module = await import("./monaco-text-viewer.tsx");
  return { default: module.MonacoTextViewer };
});
const inlineOpenLimitBytes = 1024 * 1024;

type FileReadState =
  | {
      phase: "loading";
    }
  | {
      draftText: string;
      phase: "ready";
      saveError?: string;
      saving: boolean;
    }
  | {
      phase: "error";
      message: string;
    };
const textViewerName = "text viewer";
export default function TextFileViewer() {
  let alive = true;
  let saveGeneration = 0;
  onCleanup(() => {
    alive = false;
    saveGeneration++;
  });
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const viewer = useBunja(fileViewerBunja);
  const tabState = useBunja(workbenchTabBunja);
  const fsEntry = requireFsEntry(useContext(FsEntryContext));
  const viewerState = () => viewer().state();
  const machine = () => viewer().machine();
  const dirty = () => tabState().dirty();
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
  const fileVersionKey = createMemo(() =>
    textFileVersionKey(fsEntry().path, fsEntry().size, fsEntry().modifiedAtMs),
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

  const loadedFileVersionKeyRef = { current: undefined as string | undefined };
  const ownSavedFileVersionRef = {
    current: undefined as
      | {
          modifiedAtMs?: number;
          path: string;
          size: number;
        }
      | undefined,
  };
  const savedTextRef = { current: undefined as string | undefined };
  createEffect(
    () => ({
      confirmed: confirmed(),
      machine: machine(),
      viewerState: viewerState(),
      dirty: dirty(),
      fileVersionKey: fileVersionKey(),
      fsEntry: fsEntry(),
      tabState: tabState(),
      webTransport: webTransport(),
    }),
    ({
      confirmed: currentConfirmed,
      machine: currentMachine,
      viewerState: currentViewerState,
      dirty: currentDirty,
      fileVersionKey: currentFileVersionKey,
      fsEntry: currentFsEntry,
      tabState: currentTabState,
      webTransport: currentWebTransport,
    }) => {
      if (
        !currentConfirmed ||
        !currentMachine ||
        currentViewerState.phase !== "ready"
      )
        return;
      if (currentDirty) return;
      if (loadedFileVersionKeyRef.current === currentFileVersionKey) return;
      if (
        ownSavedFileVersionRef.current &&
        isOwnSavedFileVersion(ownSavedFileVersionRef.current, currentFsEntry)
      ) {
        loadedFileVersionKeyRef.current = currentFileVersionKey;
        ownSavedFileVersionRef.current = undefined;
        return;
      }
      let cancelled = false;
      savedTextRef.current = undefined;
      currentTabState.setDirty(false);
      setState({ phase: "loading" });
      void (async () => {
        try {
          const bytes = await readFileBytes(
            await currentWebTransport(),
            currentFsEntry.path,
          );
          if (cancelled) return;
          const text = decodeTextFile(bytes);
          loadedFileVersionKeyRef.current = currentFileVersionKey;
          savedTextRef.current = text;
          setState({
            draftText: text,
            phase: "ready",
            saving: false,
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
  function changeDraftText(nextText: string) {
    const currentTabState = tabState();
    currentTabState.setDirty(
      savedTextRef.current !== undefined && nextText !== savedTextRef.current,
    );
    setState((current) => {
      if (current.phase !== "ready") return current;
      return {
        ...current,
        draftText: nextText,
        saveError: undefined,
      };
    });
  }
  function saveDraftText(nextText: string) {
    const saveId = ++saveGeneration;
    const savedEntry = fsEntry();
    const savedViewer = viewer();
    const currentWebTransport = webTransport();
    const currentFileVersionKey = fileVersionKey();
    const currentTabState = tabState();
    setState((current) =>
      current.phase === "ready"
        ? {
            ...current,
            draftText: nextText,
            saveError: undefined,
            saving: true,
          }
        : current,
    );
    void (async () => {
      try {
        const bytes = new TextEncoder().encode(nextText);
        const result = await writeFile(await currentWebTransport(), [
          {
            type: "writeFileStart",
            path: savedEntry.path,
            mode: WriteFileMode.Replace,
            expectedResultSize: bytes.byteLength,
          },
          { type: "writeFileChunk", bytes },
        ]);
        if (
          !alive ||
          saveId !== saveGeneration ||
          viewer().fsEntry.path !== savedEntry.path ||
          viewer().tabId !== savedViewer.tabId ||
          viewer().machine !== savedViewer.machine
        )
          return;
        loadedFileVersionKeyRef.current = currentFileVersionKey;
        ownSavedFileVersionRef.current = {
          modifiedAtMs: result.modifiedAtMs,
          path: savedEntry.path,
          size: result.resultSize,
        };
        savedTextRef.current = nextText;
        setState((current) =>
          current.phase === "ready"
            ? {
                ...current,
                draftText: nextText,
                saveError: undefined,
                saving: false,
              }
            : current,
        );
        currentTabState.setDirty(false);
      } catch (err) {
        if (
          !alive ||
          saveId !== saveGeneration ||
          viewer().fsEntry.path !== savedEntry.path ||
          viewer().tabId !== savedViewer.tabId ||
          viewer().machine !== savedViewer.machine
        )
          return;
        setState((current) =>
          current.phase === "ready"
            ? {
                ...current,
                saveError: err instanceof Error ? err.message : String(err),
                saving: false,
              }
            : current,
        );
      }
    })();
  }
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
          viewerName={textViewerName}
        />
      ) : state().phase === "loading" ? (
        <div {...styles.fileViewerStatus()}>
          <span>Loading text</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>{errorMessage()}</span>
        </div>
      ) : (
        <Loading
          fallback={
            <div {...styles.fileViewerStatus()}>
              <span>Loading editor</span>
            </div>
          }
        >
          <div {...styles.div()}>
            <MonacoTextViewer
              path={fsEntry().path}
              text={readyState()!.draftText}
              onChange={changeDraftText}
              onSave={saveDraftText}
            />
            {readyState()!.saving || readyState()!.saveError ? (
              <div {...styles.div2()}>
                {readyState()!.saving ? "Saving" : readyState()!.saveError}
              </div>
            ) : null}
          </div>
        </Loading>
      )}
    </>
  );
}
function decodeTextFile(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function textFileVersionKey(
  path: string,
  size: number | undefined,
  modifiedAtMs: number | undefined,
): string {
  return [path, size ?? "", modifiedAtMs ?? ""].join("\n");
}
function isOwnSavedFileVersion(
  saved: {
    modifiedAtMs?: number;
    path: string;
    size: number;
  },
  entry: FsEntry,
): boolean {
  if (entry.path !== saved.path || entry.size !== saved.size) return false;
  return (
    saved.modifiedAtMs === undefined ||
    entry.modifiedAtMs === saved.modifiedAtMs
  );
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
  export const div = style({
    position: "relative",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
  });
  export const div2 = style({
    position: "absolute",
    bottom: "8px",
    right: "8px",
    zIndex: 2,
    borderWidth: "1px",
    borderColor: "rgb(216 221 231 / 1)",
    borderRadius: "4px",
    backgroundColor: "rgb(255 255 255 / 1)",
    paddingLeft: "8px",
    paddingRight: "8px",
    paddingTop: "4px",
    paddingBottom: "4px",
    color: "rgb(52 64 84 / 1)",
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), 0 8px 24px rgb(16 24 40 / 12%)",
  });
}
