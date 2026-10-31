import { untrack, createMemo, createSignal, createEffect } from "solid-js";
import { useAtomValue } from "../../../../solid/jotai.tsx";
import { useBunja } from "../../../../solid/bunja.tsx";
import {
  FilePlus2,
  HardDrive,
  Info,
  KeyRound,
  Loader2,
  Pencil,
  SquareTerminal,
  Trash2,
  X,
} from "../../../../solid/icons.tsx";
import {
  createNodes,
  deletePaths,
  getDaemonEnvironment,
  renamePaths,
} from "../../../../protocol/generated/client.ts";
import {
  DeleteMode,
  type FsEntry,
  FsEntryKind,
} from "../../../../protocol/generated/rpc.ts";
import {
  displayName,
  explorerBunja,
  writeExplorerFileNavigationState,
} from "../../../../state/explorer.ts";
import { machineModalBunja } from "../../../../state/machine-modal.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import { rpcSessionBunja } from "../../../../state/rpc-session.ts";
import {
  workbenchBunja,
  workbenchPaneBunja,
  workbenchTabBunja,
} from "../../../../state/workbench.ts";
import {
  type FilesActions,
  FilesActionsContext,
  FilesCreateFileContext,
  type FilesCreateFileState,
  FilesExplorerContext,
  FilesRenameContext,
  type FilesRenameState,
} from "./context.tsx";
import { Button } from "../../../ui/button.tsx";
import { FilesContent } from "./content/index.tsx";
import { EntryPropertiesModal } from "./content/directory/index.tsx";
import { FilesNavbar } from "./navbar/index.tsx";
import {
  clampFloatingMenuPosition,
  FloatingMenu,
  FloatingMenuItem,
} from "../../../ui/floating-menu.tsx";
import { filesToolBunja } from "./state.ts";
const emptyWorkspaceClassName = [
  "grid content-center justify-items-center w-full h-full gap-[10px]",
  "min-h-0 text-rieul-text-3",
  "[&_h2]:m-0 [&_h2]:text-rieul-text [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");
const explorerClassName = [
  "grid [grid-template-rows:auto_minmax(0,1fr)] gap-[5px]",
  "w-full h-full min-h-0 overflow-hidden p-[6px]",
  "bg-[rgba(247,247,248,0.72)]",
].join(" ");
const entryContextMenuWidth = 176;
const modalBackdropClassName =
  "fixed inset-0 z-[20] grid place-items-center bg-rieul-overlay p-[24px]";
const modalClassName = [
  "w-[min(460px,100%)] overflow-hidden border border-rieul-border",
  "rounded-rieul-xl bg-rieul-surface shadow-rieul-lg",
].join(" ");
const modalHeadClassName = [
  "flex items-center justify-between gap-[12px] border-b border-b-rieul-border",
  "px-[16px] py-[14px]",
  "[&_div]:grid [&_div]:gap-[2px] [&_div]:min-w-0",
  "[&_span]:text-rieul-text-3 [&_span]:text-[13px] [&_span]:font-600",
  "[&_h2]:m-0 [&_h2]:text-rieul-text [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");
const iconButtonClassName = "!w-[36px] !min-w-[36px] !p-0";
const deleteDialogBodyClassName = [
  "grid gap-[12px] p-[16px]",
  "[&_p]:m-0 [&_p]:text-rieul-text-2 [&_p]:text-[14px] [&_p]:leading-[1.45]",
].join(" ");
const entrySummaryClassName = [
  "grid gap-[2px] min-w-0 border border-rieul-border rounded-rieul-lg",
  "bg-rieul-surface-2 p-[10px]",
  "[&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis",
  "[&_strong]:whitespace-nowrap [&_strong]:text-rieul-text [&_strong]:text-[14px]",
  "[&_span]:min-w-0 [&_span]:[overflow-wrap:anywhere]",
  "[&_span]:text-rieul-text-3 [&_span]:text-[13px]",
].join(" ");
const modalActionsClassName = "flex justify-end gap-[8px]";
const dangerActionClassName = [
  "border-rieul-danger bg-rieul-danger-soft text-rieul-danger",
  "hover:border-rieul-danger hover:bg-rieul-danger-soft hover:text-rieul-danger",
].join(" ");
const fieldErrorClassName = "text-rieul-danger text-[13px]";
interface EntryMenuState {
  entry: FsEntry;
  x: number;
  y: number;
}
interface FolderMenuState {
  x: number;
  y: number;
}
interface DeleteEntryState {
  entry: FsEntry;
  error?: string;
  isDeleting: boolean;
}
interface RenameEntryState {
  draftName: string;
  entry: FsEntry;
  error?: string;
  isRenaming: boolean;
}
interface CreateFileState {
  draftName: string;
  error?: string;
  isCreating: boolean;
}
interface DeleteEntryModalProps {
  state: DeleteEntryState;
  onClose: () => void;
  onDelete: () => void;
}
export function FilesTool() {
  const machineModal = useBunja(machineModalBunja);
  const machineStore = useBunja(machineStoreBunja);
  const rpcSession = useBunja(rpcSessionBunja);
  const filesTool = useBunja(filesToolBunja);
  const machine = useAtomValue(() => machineStore().selectedAtom);
  const isPaired = useAtomValue(() => machineStore().selectedIsPairedAtom);
  const daemonInstanceId = useAtomValue(
    () => rpcSession().daemonInstanceIdAtom,
  );
  const workbench = useBunja(workbenchBunja);
  const paneState = useBunja(workbenchPaneBunja);
  const tabState = useBunja(workbenchTabBunja);
  const tab = useAtomValue(() => tabState().tabAtom);
  const initialLocation = createMemo(
    () => {
      const current = tab();
      return { tool: current?.tool, filesView: current?.filesView };
    },
    {
      equals: (previous, next) =>
        previous.tool === next.tool && previous.filesView === next.filesView,
    },
  );
  const explorer = useBunja(explorerBunja);
  const initialFilesLocationAppliedRef = { current: false };
  const currentPathAtom = createMemo(() => explorer().currentPathAtom);
  const goBack = createMemo(() => explorer().goBack);
  const goUp = createMemo(() => explorer().goUp);
  const navigate = createMemo(() => explorer().navigate);
  const openEntry = createMemo(() => explorer().openEntry);
  const selectEntry = createMemo(() => explorer().selectEntry);
  const openedFile = useAtomValue(() => explorer().openedFileAtom);
  const specialLocation = useAtomValue(() => explorer().specialLocationAtom);
  const currentPath = useAtomValue(() => currentPathAtom());
  const filesView = createMemo(() =>
    specialLocation() === "trash" ? "trash" : "browser",
  );
  const lastDaemonInstanceIdRef = { current: untrack(daemonInstanceId) };
  const [entryMenu, setEntryMenu] = createSignal<EntryMenuState>();
  const [folderMenu, setFolderMenu] = createSignal<FolderMenuState>();
  const [propertiesEntry, setPropertiesEntry] = createSignal<FsEntry>();
  const [deleteEntry, setDeleteEntry] = createSignal<DeleteEntryState>();
  const [renameEntry, setRenameEntry] = createSignal<RenameEntryState>();
  const [createFile, setCreateFile] = createSignal<CreateFileState>();
  const defaultShell = useAtomValue(() => filesTool().defaultShellAtom);
  const terminalShells = useAtomValue(() => filesTool().terminalShellsAtom);
  createEffect(
    () => ({
      tab: initialLocation(),
      explorer: explorer(),
      machine: machine(),
      isPaired: isPaired(),
      rpcSession: rpcSession(),
    }),
    ({
      tab: currentTab,
      explorer: currentExplorer,
      machine: currentMachine,
      isPaired: currentIsPaired,
      rpcSession: currentRpcSession,
    }) => {
      if (initialFilesLocationAppliedRef.current) return;
      if (currentTab?.tool !== "files") return;
      if (currentTab.filesView === "trash") {
        initialFilesLocationAppliedRef.current = true;
        currentExplorer.replaceWithTrash();
        return;
      }
      if (currentTab.filesView !== "home") {
        initialFilesLocationAppliedRef.current = true;
        return;
      }
      if (!currentMachine || !currentIsPaired) return;
      let cancelled = false;
      void (async () => {
        try {
          const transport = await currentRpcSession.webTransport();
          const environment = await getDaemonEnvironment(transport);
          if (cancelled || !environment.homeDirectory) return;
          initialFilesLocationAppliedRef.current = true;
          currentExplorer.replaceWithPath(environment.homeDirectory);
        } catch {
          if (cancelled) return;
          initialFilesLocationAppliedRef.current = true;
          // Keep the roots view when the daemon cannot provide a home directory.
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  );
  createEffect(
    () => ({ daemonInstanceId: daemonInstanceId(), explorer: explorer() }),
    ({
      daemonInstanceId: currentDaemonInstanceId,
      explorer: currentExplorer,
    }) => {
      if (lastDaemonInstanceIdRef.current === currentDaemonInstanceId) return;
      lastDaemonInstanceIdRef.current = currentDaemonInstanceId;
      if (!currentDaemonInstanceId) return;
      currentExplorer.refresh();
    },
  );
  createEffect(
    () => ({ entryMenu: entryMenu(), folderMenu: folderMenu() }),
    ({ entryMenu: currentEntryMenu, folderMenu: currentFolderMenu }) => {
      if (!currentEntryMenu && !currentFolderMenu) return;
      function closeMenu() {
        setEntryMenu(undefined);
        setFolderMenu(undefined);
      }
      function closeMenuOnEscape(event: KeyboardEvent) {
        if (event.key === "Escape") closeMenu();
      }
      globalThis.addEventListener("mousedown", closeMenu);
      globalThis.addEventListener("keydown", closeMenuOnEscape);
      return () => {
        globalThis.removeEventListener("mousedown", closeMenu);
        globalThis.removeEventListener("keydown", closeMenuOnEscape);
      };
    },
  );
  createEffect(
    () => ({ propertiesEntry: propertiesEntry() }),
    ({ propertiesEntry: currentPropertiesEntry }) => {
      if (!currentPropertiesEntry) return;
      function closeModalOnEscape(event: KeyboardEvent) {
        if (event.key === "Escape") setPropertiesEntry(undefined);
      }
      globalThis.addEventListener("keydown", closeModalOnEscape);
      return () =>
        globalThis.removeEventListener("keydown", closeModalOnEscape);
    },
  );
  createEffect(
    () => ({ deleteEntry: deleteEntry() }),
    ({ deleteEntry: currentDeleteEntry }) => {
      if (!currentDeleteEntry || currentDeleteEntry.isDeleting) return;
      function closeModalOnEscape(event: KeyboardEvent) {
        if (event.key === "Escape") setDeleteEntry(undefined);
      }
      globalThis.addEventListener("keydown", closeModalOnEscape);
      return () =>
        globalThis.removeEventListener("keydown", closeModalOnEscape);
    },
  );
  function goBackFromToolbar() {
    const currentGoBack = goBack();
    currentGoBack();
  }
  function goUpFromToolbar() {
    const currentGoUp = goUp();
    currentGoUp();
  }
  function navigateFromToolbar(path?: string) {
    const currentOpenedFile = openedFile();
    const currentNavigate = navigate();
    if (currentOpenedFile && path === currentOpenedFile.path) return;
    currentNavigate(path);
  }
  function openTableEntry(entry: FsEntry) {
    const currentOpenEntry = openEntry();
    const currentSelectEntry = selectEntry();
    const currentPaneState = paneState();
    const currentMachine = machine();
    const currentCurrentPath = currentPath();
    if (entry.kind === FsEntryKind.Directory) {
      currentOpenEntry(entry);
      return;
    }
    if (entry.kind !== FsEntryKind.File) {
      currentSelectEntry(entry);
      return;
    }
    currentSelectEntry(entry);
    const tabId = currentPaneState.addFilesTab();
    writeExplorerFileNavigationState(
      currentMachine?.id,
      tabId,
      currentCurrentPath,
      entry,
    );
  }
  function openEntryMenu(entry: FsEntry, event: MouseEvent) {
    const currentSelectEntry = selectEntry();
    const currentCurrentPath = currentPath();
    event.preventDefault();
    event.stopPropagation();
    currentSelectEntry(entry);
    setFolderMenu(undefined);
    setEntryMenu({
      entry,
      ...entryContextMenuPosition(
        event.clientX,
        event.clientY,
        Boolean(currentCurrentPath),
      ),
    });
  }
  function openFolderMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setEntryMenu(undefined);
    setFolderMenu(folderContextMenuPosition(event.clientX, event.clientY));
  }
  function openEntryProperties(entry: FsEntry) {
    setEntryMenu(undefined);
    setPropertiesEntry(entry);
  }
  function openRenameEntry(entry: FsEntry) {
    const currentSelectEntry = selectEntry();
    setEntryMenu(undefined);
    currentSelectEntry(entry);
    setRenameEntry({
      draftName: displayName(entry),
      entry,
      isRenaming: false,
    });
  }
  function openDeleteEntry(entry: FsEntry) {
    setEntryMenu(undefined);
    setDeleteEntry({ entry, isDeleting: false });
  }
  function openCreateFile() {
    const currentCurrentPath = currentPath();
    setFolderMenu(undefined);
    if (!currentCurrentPath) return;
    setCreateFile({ draftName: "", isCreating: false });
  }
  function openTerminalHere() {
    const currentCurrentPath = currentPath();
    const currentDefaultShell = defaultShell();
    const currentWorkbench = workbench();
    setFolderMenu(undefined);
    if (!currentCurrentPath) return;
    const shell = currentDefaultShell;
    if (!shell) return;
    currentWorkbench.openTerminalTab({
      cwd: currentCurrentPath,
      launch: {
        command: shell.command,
        args: shell.args,
      },
      title: shell.name,
    });
  }
  async function deleteSelectedEntry() {
    const currentMachine = machine();
    const currentDeleteEntry = deleteEntry();
    const currentRpcSession = rpcSession();
    if (!currentMachine || !currentDeleteEntry || currentDeleteEntry.isDeleting)
      return;
    setDeleteEntry((current) =>
      current ? { ...current, error: undefined, isDeleting: true } : current,
    );
    try {
      const transport = await currentRpcSession.webTransport();
      const result = await deletePaths(transport, {
        paths: [currentDeleteEntry.entry.path],
        mode: DeleteMode.Trash,
      });
      const failure = result.results.find((item) => item.type === "failed");
      if (failure?.type === "failed") {
        setDeleteEntry((current) =>
          current
            ? {
                ...current,
                error: failure.error.message || failure.error.type,
                isDeleting: false,
              }
            : current,
        );
        return;
      }
      setDeleteEntry(undefined);
    } catch (err) {
      setDeleteEntry((current) =>
        current
          ? {
              ...current,
              error: err instanceof Error ? err.message : String(err),
              isDeleting: false,
            }
          : current,
      );
    }
  }
  async function commitRename(entry: FsEntry) {
    const currentMachine = machine();
    const currentCurrentPath = currentPath();
    const currentRenameEntry = renameEntry();
    const currentRpcSession = rpcSession();
    if (
      !currentMachine ||
      !currentCurrentPath ||
      !currentRenameEntry ||
      currentRenameEntry.entry.path !== entry.path ||
      currentRenameEntry.isRenaming
    ) {
      return;
    }
    const nextName = currentRenameEntry.draftName;
    if (nextName === displayName(entry)) {
      setRenameEntry(undefined);
      return;
    }
    if (nextName.trim() === "") {
      setRenameEntry((current) =>
        current && current.entry.path === entry.path
          ? { ...current, error: "Name is required." }
          : current,
      );
      return;
    }
    setRenameEntry((current) =>
      current && current.entry.path === entry.path
        ? { ...current, error: undefined, isRenaming: true }
        : current,
    );
    try {
      const transport = await currentRpcSession.webTransport();
      const to = childPath(currentCurrentPath, nextName);
      const result = await renamePaths(transport, {
        ops: [{ from: entry.path, to }],
      });
      const failure = result.results.find((item) => item.type === "failed");
      if (failure?.type === "failed") {
        setRenameEntry((current) =>
          current && current.entry.path === entry.path
            ? {
                ...current,
                error: failure.error.message || failure.error.type,
                isRenaming: false,
              }
            : current,
        );
        return;
      }
      setRenameEntry(undefined);
    } catch (err) {
      setRenameEntry((current) =>
        current && current.entry.path === entry.path
          ? {
              ...current,
              error: err instanceof Error ? err.message : String(err),
              isRenaming: false,
            }
          : current,
      );
    }
  }
  async function commitCreateFile() {
    const currentMachine = machine();
    const currentCurrentPath = currentPath();
    const currentCreateFile = createFile();
    const currentRpcSession = rpcSession();
    if (
      !currentMachine ||
      !currentCurrentPath ||
      !currentCreateFile ||
      currentCreateFile.isCreating
    ) {
      return;
    }
    const name = currentCreateFile.draftName.trim();
    if (name === "") {
      setCreateFile(undefined);
      return;
    }
    setCreateFile((current) =>
      current ? { ...current, error: undefined, isCreating: true } : current,
    );
    try {
      const transport = await currentRpcSession.webTransport();
      const result = await createNodes(transport, {
        nodes: [
          {
            path: childPath(currentCurrentPath, name),
            spec: { type: "file" },
          },
        ],
      });
      const failure = result.results.find((item) => item.type === "failed");
      if (failure?.type === "failed") {
        setCreateFile((current) =>
          current
            ? {
                ...current,
                error: failure.error.message || failure.error.type,
                isCreating: false,
              }
            : current,
        );
        return;
      }
      setCreateFile(undefined);
    } catch (err) {
      setCreateFile((current) =>
        current
          ? {
              ...current,
              error: err instanceof Error ? err.message : String(err),
              isCreating: false,
            }
          : current,
      );
    }
  }
  const actions: FilesActions = {
    goBack: goBackFromToolbar,
    goUp: goUpFromToolbar,
    navigate: navigateFromToolbar,
    openEntry: openTableEntry,
    openEntryMenu,
    openFolderMenu,
    selectEntry: (entry) => selectEntry()(entry),
  };
  const renameState = createMemo<FilesRenameState>(() => ({
    draftName: renameEntry()?.draftName ?? "",
    entryPath: renameEntry()?.entry.path,
    error: renameEntry()?.error,
    isRenaming: renameEntry()?.isRenaming ?? false,
    cancelRename: () => setRenameEntry(undefined),
    commitRename,
    updateDraftName: (draftName) =>
      setRenameEntry((current) =>
        current ? { ...current, draftName, error: undefined } : current,
      ),
  }));
  const createFileState = createMemo<FilesCreateFileState>(() => ({
    draftName: createFile()?.draftName ?? "",
    error: createFile()?.error,
    isCreating: createFile()?.isCreating ?? false,
    isEditing: Boolean(createFile()),
    cancelCreate: () => setCreateFile(undefined),
    commitCreate: commitCreateFile,
    updateDraftName: (draftName) =>
      setCreateFile((current) =>
        current ? { ...current, draftName, error: undefined } : current,
      ),
  }));
  return (
    <>
      {!machine() ? (
        <section class={emptyWorkspaceClassName}>
          <HardDrive size={28} />
          <h2>No machine selected</h2>
        </section>
      ) : !isPaired() ? (
        <section class={emptyWorkspaceClassName}>
          <KeyRound size={28} />
          <h2>Pairing required</h2>
          <Button
            onClick={() =>
              machine() && machineModal().openPairMachineModal(machine()!.id)
            }
          >
            <KeyRound size={16} />
            Pair
          </Button>
        </section>
      ) : (
        <section class={explorerClassName}>
          <FilesExplorerContext value={() => explorer()}>
            <FilesActionsContext value={() => actions}>
              <FilesCreateFileContext value={() => createFileState()}>
                <FilesRenameContext value={() => renameState()}>
                  <FilesNavbar />

                  <FilesContent view={filesView()} />
                </FilesRenameContext>
              </FilesCreateFileContext>
            </FilesActionsContext>
          </FilesExplorerContext>

          {entryMenu() ? (
            <FloatingMenu
              className="z-[30] w-[176px]"
              position={{ left: entryMenu()!.x, top: entryMenu()!.y }}
            >
              <FloatingMenuItem
                onClick={() => openEntryProperties(entryMenu()!.entry)}
              >
                <Info size={15} />
                Properties
              </FloatingMenuItem>
              {currentPath() ? (
                <>
                  <FloatingMenuItem
                    onClick={() => openRenameEntry(entryMenu()!.entry)}
                  >
                    <Pencil size={15} />
                    Rename
                  </FloatingMenuItem>
                  <FloatingMenuItem
                    tone="danger"
                    onClick={() => openDeleteEntry(entryMenu()!.entry)}
                  >
                    <Trash2 size={15} />
                    Delete...
                  </FloatingMenuItem>
                </>
              ) : null}
            </FloatingMenu>
          ) : null}

          {folderMenu() ? (
            <FloatingMenu
              className="z-[30] w-[176px]"
              position={{ left: folderMenu()!.x, top: folderMenu()!.y }}
            >
              <FloatingMenuItem
                disabled={!currentPath()}
                onClick={openCreateFile}
              >
                <FilePlus2 size={15} />
                New file
              </FloatingMenuItem>
              <FloatingMenuItem
                disabled={!currentPath() || terminalShells().length === 0}
                onClick={openTerminalHere}
              >
                <SquareTerminal size={15} />
                Open terminal here
              </FloatingMenuItem>
            </FloatingMenu>
          ) : null}

          {propertiesEntry() ? (
            <EntryPropertiesModal
              entry={propertiesEntry()!}
              onClose={() => setPropertiesEntry(undefined)}
            />
          ) : null}

          {deleteEntry() ? (
            <DeleteEntryModal
              state={deleteEntry()!}
              onClose={() => {
                if (!deleteEntry()!.isDeleting) setDeleteEntry(undefined);
              }}
              onDelete={deleteSelectedEntry}
            />
          ) : null}
        </section>
      )}
    </>
  );
}
function entryContextMenuPosition(
  x: number,
  y: number,
  hasDeleteItem: boolean,
): {
  x: number;
  y: number;
} {
  const position = clampFloatingMenuPosition(x, y, {
    itemCount: hasDeleteItem ? 3 : 1,
    width: entryContextMenuWidth,
  });
  return { x: position.left, y: position.top };
}
function folderContextMenuPosition(
  x: number,
  y: number,
): {
  x: number;
  y: number;
} {
  const position = clampFloatingMenuPosition(x, y, {
    itemCount: 2,
    width: entryContextMenuWidth,
  });
  return { x: position.left, y: position.top };
}
function childPath(directory: string, name: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return directory.endsWith("/") || directory.endsWith("\\")
    ? `${directory}${name}`
    : `${directory}${separator}${name}`;
}
function DeleteEntryModal(props: DeleteEntryModalProps) {
  return (
    <div
      class={modalBackdropClassName}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.state.isDeleting) {
          props.onClose();
        }
      }}
    >
      <section
        class={modalClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-entry-title"
      >
        <header class={modalHeadClassName}>
          <div>
            <span>File</span>
            <h2 id="delete-entry-title">Delete</h2>
          </div>
          <Button
            onClick={props.onClose}
            title="Close"
            aria-label="Close delete dialog"
            disabled={props.state.isDeleting}
            className={iconButtonClassName}
          >
            <X size={16} />
          </Button>
        </header>

        <div class={deleteDialogBodyClassName}>
          <div class={entrySummaryClassName}>
            <strong>{displayName(props.state.entry)}</strong>
            <span>{props.state.entry.path}</span>
          </div>
          <p>This moves the selected item to the system trash.</p>
          {props.state.error ? (
            <div class={fieldErrorClassName}>{props.state.error}</div>
          ) : null}
          <div class={modalActionsClassName}>
            <Button onClick={props.onClose} disabled={props.state.isDeleting}>
              Cancel
            </Button>
            <Button
              className={dangerActionClassName}
              onClick={props.onDelete}
              disabled={props.state.isDeleting}
            >
              {props.state.isDeleting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Trash2 size={16} />
              )}
              Delete
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
