import {
  onCleanup,
  createMemo,
  createSignal,
  createEffect,
  useContext,
  lazy,
  Loading,
} from "solid-js";
import { useBunja } from "../../../../../../../../solid/bunja.tsx";
import { useAtomValue } from "../../../../../../../../solid/jotai.tsx";
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
const fileViewerStatusClassName = [
  "flex items-center justify-center gap-[8px] min-w-0 min-h-0",
  "text-[#667085] text-[14px]",
  "[&.error]:items-start [&.error]:justify-start [&.error]:overflow-auto",
  "[&.error]:text-[#b42318] [&.error]:p-[14px]",
].join(" ");
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
  const viewerState = useAtomValue(() => viewer().stateAtom);
  const machine = useAtomValue(() => viewer().machineAtom);
  const dirty = useAtomValue(() => tabState().dirtyAtom);
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
          viewer().machineAtom !== savedViewer.machineAtom
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
          viewer().machineAtom !== savedViewer.machineAtom
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
        <div class={`${fileViewerStatusClassName} error`}>
          <span>No machine selected</span>
        </div>
      ) : viewerState().phase !== "ready" ? null : !confirmed() ? (
        <BigFileWarning
          onCancel={actions().goBack}
          onConfirm={() => setConfirmedFsEntryPath(fsEntry().path)}
          viewerName={textViewerName}
        />
      ) : state().phase === "loading" ? (
        <div class={fileViewerStatusClassName}>
          <span>Loading text</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${fileViewerStatusClassName} error`}>
          <span>{errorMessage()}</span>
        </div>
      ) : (
        <Loading
          fallback={
            <div class={fileViewerStatusClassName}>
              <span>Loading editor</span>
            </div>
          }
        >
          <div class="relative w-full h-full min-w-0 min-h-0">
            <MonacoTextViewer
              path={fsEntry().path}
              text={readyState()!.draftText}
              onChange={changeDraftText}
              onSave={saveDraftText}
            />
            {readyState()!.saving || readyState()!.saveError ? (
              <div class="absolute right-[8px] bottom-[8px] z-[2] rounded-[4px] border border-[#d8dde7] bg-white px-[8px] py-[4px] text-[#344054] shadow-[0_8px_24px_rgb(16_24_40_/_12%)]">
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
