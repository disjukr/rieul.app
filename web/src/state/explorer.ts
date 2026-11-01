import { bunja } from "bunja";
import {
  createSignal,
  createMemo,
  createEffect,
  untrack,
  flush,
  type Setter,
} from "solid-js";
import { isInvalidCredentialsError } from "../protocol/client.ts";
import {
  subscribeDirectory,
  subscribeRoots,
} from "../protocol/generated/client.ts";
import {
  type DirectorySubscriptionCloseReason,
  type DirectoryTableEvent,
  type FsEntry,
  FsEntryKind,
  type RootsSubscriptionCloseReason,
  type RootsTableEvent,
} from "../protocol/generated/rpc.ts";
import { MachineIdScope } from "./machine-scopes.ts";
import { machineBunja, machineStoreBunja } from "./machine-store.ts";
import { Machine } from "./machines.ts";
import { rpcSessionBunja } from "./rpc-session.ts";
import { StreamState } from "./types.ts";
import { WorkbenchTabIdScope } from "./workbench-scopes.ts";

export const trashLocationPath = "rieul://trash";
const invalidPairingMessage =
  "Pairing is no longer valid. Pair this machine again.";

export type ExplorerSpecialLocation = "trash";

export type ExplorerLocation =
  | { type: "root" }
  | { type: "directory"; path: string }
  | { type: "file"; directoryPath?: string; entry: FsEntry }
  | { type: "trash" };

interface ExplorerNavigationState {
  history: ExplorerLocation[];
  location: ExplorerLocation;
}

export const explorerMachineBunja = bunja(() => {
  const machine = bunja.use(machineBunja);
  const connectionKey = createMemo(() =>
    explorerConnectionKey(machine.machine()),
  );
  return {
    machine: machine.machine,
    isPaired: machine.isPaired,
    connectionKey,
  };
});

export const explorerRefreshBunja = bunja(() => {
  bunja.use(MachineIdScope);
  bunja.use(WorkbenchTabIdScope);
  const [refreshRevision, setRefreshRevision] = createSignal(0);
  function refresh() {
    setRefreshRevision((current) => current + 1);
  }
  return { refreshRevision, refresh };
});

export const explorerNavigationBunja = bunja(() => {
  const machineId = bunja.use(MachineIdScope);
  const tabId = requireScopeValue(
    bunja.use(WorkbenchTabIdScope),
    "Workbench tab id",
  );
  const storageKey = explorerNavigationStorageKey(machineId, tabId);
  const empty: ExplorerNavigationState = {
    history: [],
    location: { type: "root" },
  };
  let initial = empty;
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
    const saved = storage?.getItem(storageKey);
    if (saved !== null && saved !== undefined)
      initial = JSON.parse(saved) as ExplorerNavigationState;
  } catch {
    /* Match the existing unavailable/corrupt-storage fallback. */
  }
  const [navigationState, setNavigationState] = createSignal(initial);
  const location = createMemo(() => navigationState().location);
  const currentPath = createMemo(() => currentPathFromLocation(location()));
  const directoryPath = createMemo(() => directoryPathFromLocation(location()));
  const openedFile = createMemo(() => {
    const current = location();
    return current.type === "file" ? current.entry : undefined;
  });
  const displayPath = createMemo(() => displayPathFromLocation(location()));
  const specialLocation = createMemo<ExplorerSpecialLocation | undefined>(() =>
    location().type === "trash" ? "trash" : undefined,
  );
  const history = createMemo(() => navigationState().history);
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>();

  function persistNavigation(next: ExplorerNavigationState) {
    storage?.setItem(storageKey, JSON.stringify(next));
  }
  bunja.effect(() => {
    function onStorage(event: StorageEvent) {
      if (
        event.key !== storageKey ||
        (event.storageArea && event.storageArea !== storage)
      )
        return;
      try {
        setNavigationState(
          event.newValue === null
            ? empty
            : (JSON.parse(event.newValue) as ExplorerNavigationState),
        );
      } catch {
        setNavigationState(empty);
      }
    }
    globalThis.addEventListener?.("storage", onStorage);
    return () => globalThis.removeEventListener?.("storage", onStorage);
  });
  function selectEntry(entry: FsEntry) {
    setSelectedPath(entry.path);
  }
  function navigate(path?: string) {
    if (path === trashLocationPath) {
      navigateTrash();
      return;
    }
    navigateTo(locationFromPath(path));
  }
  function navigateTo(next: ExplorerLocation) {
    const updated = setNavigationState((current) => ({
      history: [...current.history, current.location],
      location: next,
    }));
    persistNavigation(updated);
    setSelectedPath(undefined);
  }
  function navigateTrash() {
    navigateTo({ type: "trash" });
  }
  function replaceWithLocation(next: ExplorerLocation) {
    const updated = setNavigationState((current) => ({
      ...current,
      location: next,
    }));
    persistNavigation(updated);
    setSelectedPath(undefined);
  }
  function replaceWithTrash() {
    replaceWithLocation({ type: "trash" });
  }
  function replaceWithPath(path?: string) {
    replaceWithLocation(locationFromPath(path));
  }
  function replaceWithMovedDirectory(path?: string) {
    const updated = setNavigationState({
      history: [],
      location: locationFromPath(path),
    });
    persistNavigation(updated);
    setSelectedPath(undefined);
  }
  function goBack() {
    let moved = false;
    const updated = setNavigationState((current) => {
      if (!current.history.length) return current;
      moved = true;
      return {
        history: current.history.slice(0, -1),
        location: current.history[current.history.length - 1],
      };
    });
    if (!moved) return;
    persistNavigation(updated);
    setSelectedPath(
      updated.location.type === "file"
        ? updated.location.entry.path
        : undefined,
    );
  }
  function goUp() {
    let moved = false;
    const updated = setNavigationState((current) => {
      const previous = current.location;
      if (previous.type === "trash" || previous.type === "root") return current;
      moved = true;
      const path =
        previous.type === "file"
          ? previous.directoryPath
          : parentPath(previous.path);
      return {
        history: [...current.history, previous],
        location: locationFromPath(path),
      };
    });
    if (!moved) return;
    persistNavigation(updated);
    setSelectedPath(undefined);
  }
  function openEntry(entry: FsEntry) {
    if (entry.kind === FsEntryKind.Directory) {
      navigate(entry.path);
      return;
    }
    setSelectedPath(entry.path);
  }
  function openFile(entry: FsEntry) {
    const updated = setNavigationState((current) => ({
      history: [...current.history, current.location],
      location: {
        type: "file",
        directoryPath: directoryPathFromLocation(current.location),
        entry,
      },
    }));
    persistNavigation(updated);
    setSelectedPath(entry.path);
  }
  return {
    directoryPath,
    currentPath,
    displayPath,
    history,
    openedFile,
    selectedPath,
    setSelectedPath,
    specialLocation,
    selectEntry,
    navigate,
    navigateTrash,
    replaceWithPath,
    replaceWithMovedDirectory,
    replaceWithTrash,
    goBack,
    goUp,
    openEntry,
    openFile,
  };
});

export const explorerRootsBunja = bunja(() => {
  bunja.use(MachineIdScope);
  bunja.use(WorkbenchTabIdScope);
  const machineState = bunja.use(explorerMachineBunja);
  const machines = bunja.use(machineStoreBunja);
  const rpcSession = bunja.use(rpcSessionBunja);
  const refresh = bunja.use(explorerRefreshBunja);
  const [dataRows, setRoots] = createSignal<FsEntry[]>([]);
  const [rootsState, setRootsState] = createSignal<StreamState>({
    phase: "idle",
    message: "Roots idle",
  });
  // Bunja's mount callback can precede an observer, or vice versa. Only this
  // lifecycle gate permits writes from the graph's owned initialization scope.
  const [mounted, setMounted] = createSignal(false, { ownedWrite: true });
  let alive = false;
  let cancelStream: (() => void) | undefined;
  const subscriptionKey = createMemo(() =>
    [
      machineState.connectionKey(),
      machineState.isPaired() ? "paired" : "unpaired",
      refresh.refreshRevision(),
    ].join("\n"),
  );
  bunja.effect(() => {
    alive = true;
    setMounted(true);
    return () => {
      alive = false;
      setMounted(false);
      cancelStream?.();
      cancelStream = undefined;
    };
  });
  // The lazy demand memo owns only the subscription effect, not the row data.
  // Row patches therefore cannot recreate the stream. Its last observer
  // disposing tears down the effect; a retained observer cannot outlive Bunja.
  const demand = createMemo(
    () => {
      createEffect(
        () => (mounted() ? subscriptionKey() : undefined),
        (key) => {
          if (!alive || key === undefined) return;
          const activeMachine = untrack(machineState.machine);
          if (!activeMachine || !untrack(machineState.isPaired)) {
            setRoots([]);
            const previous = untrack(rootsState);
            if (
              previous.phase === "error" &&
              previous.message === invalidPairingMessage
            )
              return;
            setRootsState({ phase: "idle", message: "Roots idle" });
            return;
          }
          let cancelled = false;
          let iterator: AsyncGenerator<RootsTableEvent> | undefined;
          const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            void iterator?.return(undefined);
          };
          cancelStream = cancel;
          setRootsState({ phase: "connecting", message: "Opening roots" });
          void (async () => {
            try {
              const transport = await rpcSession.webTransport();
              // Commit command intent before accepting a late network result.
              flush();
              if (cancelled || !alive) return;
              iterator = subscribeRoots(transport);
              for await (const event of iterator) {
                flush();
                if (cancelled || !alive) break;
                applyRootsEvent(event, setRoots, setRootsState);
              }
            } catch (error) {
              flush();
              if (cancelled || !alive) return;
              if (
                handleInvalidCredentials(
                  activeMachine,
                  error,
                  machines.clearMachineCredentials,
                  rpcSession.closeRpcSession,
                )
              ) {
                setRootsState({
                  phase: "error",
                  message: invalidPairingMessage,
                });
                return;
              }
              setRootsState({ phase: "error", message: errorMessage(error) });
            }
          })();
          return () => {
            cancel();
            if (cancelStream === cancel) cancelStream = undefined;
          };
        },
      );
      return true;
    },
    { lazy: true },
  );
  const roots = createMemo(
    () => {
      demand();
      return dataRows();
    },
    { lazy: true },
  );
  const visibleRows = createMemo(() => sortEntries(roots()), { lazy: true });
  return { roots, rootsState, visibleRows };
});

export const explorerDirectoryBunja = bunja(() => {
  bunja.use(MachineIdScope);
  bunja.use(WorkbenchTabIdScope);
  const machineState = bunja.use(explorerMachineBunja);
  const machines = bunja.use(machineStoreBunja);
  const rpcSession = bunja.use(rpcSessionBunja);
  const refresh = bunja.use(explorerRefreshBunja);
  const navigation = bunja.use(explorerNavigationBunja);
  const [dataRows, setDirectoryRows] = createSignal<FsEntry[]>([]);
  const [directoryState, setDirectoryState] = createSignal<StreamState>({
    phase: "idle",
    message: "Directory idle",
  });
  // Bunja's mount callback can precede an observer, or vice versa. Only this
  // lifecycle gate permits writes from the graph's owned initialization scope.
  const [mounted, setMounted] = createSignal(false, { ownedWrite: true });
  let alive = false;
  let cancelStream: (() => void) | undefined;
  const subscriptionKey = createMemo(() =>
    [
      machineState.connectionKey(),
      machineState.isPaired() ? "paired" : "unpaired",
      navigation.directoryPath() ?? "",
      refresh.refreshRevision(),
    ].join("\n"),
  );
  bunja.effect(() => {
    alive = true;
    setMounted(true);
    return () => {
      alive = false;
      setMounted(false);
      cancelStream?.();
      cancelStream = undefined;
    };
  });
  // The lazy demand memo owns only the subscription effect, not the row data.
  // Row patches therefore cannot recreate the stream. Its last observer
  // disposing tears down the effect; a retained observer cannot outlive Bunja.
  const demand = createMemo(
    () => {
      createEffect(
        () => (mounted() ? subscriptionKey() : undefined),
        (key) => {
          if (!alive || key === undefined) return;
          setDirectoryRows([]);
          navigation.setSelectedPath(undefined);
          const activeMachine = untrack(machineState.machine);
          const path = untrack(navigation.directoryPath);
          if (!activeMachine || !untrack(machineState.isPaired) || !path) {
            const previous = untrack(directoryState);
            if (
              previous.phase === "error" &&
              previous.message === invalidPairingMessage
            )
              return;
            setDirectoryState({ phase: "idle", message: "Directory idle" });
            return;
          }
          let cancelled = false;
          let iterator: AsyncGenerator<DirectoryTableEvent> | undefined;
          const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            void iterator?.return(undefined);
          };
          cancelStream = cancel;
          setDirectoryState({
            phase: "connecting",
            message: "Opening directory",
          });
          void (async () => {
            try {
              const transport = await rpcSession.webTransport();
              // Commit command intent before accepting a late network result.
              flush();
              if (cancelled || !alive) return;
              iterator = subscribeDirectory(transport, { path });
              for await (const event of iterator) {
                flush();
                if (cancelled || !alive) break;
                applyDirectoryEvent(
                  event,
                  setDirectoryRows,
                  setDirectoryState,
                  (path) => navigation.replaceWithMovedDirectory(path),
                );
              }
            } catch (error) {
              flush();
              if (cancelled || !alive) return;
              if (
                handleInvalidCredentials(
                  activeMachine,
                  error,
                  machines.clearMachineCredentials,
                  rpcSession.closeRpcSession,
                )
              ) {
                setDirectoryState({
                  phase: "error",
                  message: invalidPairingMessage,
                });
                return;
              }
              setDirectoryState({
                phase: "error",
                message: errorMessage(error),
              });
            }
          })();
          return () => {
            cancel();
            if (cancelStream === cancel) cancelStream = undefined;
          };
        },
      );
      return true;
    },
    { lazy: true },
  );
  const directoryRows = createMemo(
    () => {
      demand();
      return dataRows();
    },
    { lazy: true },
  );
  const visibleRows = createMemo(() => sortEntries(directoryRows()), {
    lazy: true,
  });
  return { directoryRows, directoryState, visibleRows };
});

export const explorerBunja = bunja(() => {
  bunja.use(MachineIdScope);
  bunja.use(WorkbenchTabIdScope);
  const navigation = bunja.use(explorerNavigationBunja);
  const roots = bunja.use(explorerRootsBunja);
  const directory = bunja.use(explorerDirectoryBunja);
  const refresh = bunja.use(explorerRefreshBunja);
  const rows = createMemo(
    () =>
      navigation.directoryPath()
        ? directory.directoryRows()
        : navigation.specialLocation()
          ? []
          : roots.roots(),
    { lazy: true },
  );
  const openedFile = createMemo(
    () => {
      const file = navigation.openedFile();
      return file
        ? (rows().find((entry) => entry.path === file.path) ?? file)
        : undefined;
    },
    { lazy: true },
  );
  const visibleRows = createMemo(() => sortEntries(rows()), { lazy: true });
  const selectedEntry = createMemo(
    () => rows().find((entry) => entry.path === navigation.selectedPath()),
    { lazy: true },
  );
  return {
    currentPath: navigation.currentPath,
    directoryPath: navigation.directoryPath,
    displayPath: navigation.displayPath,
    history: navigation.history,
    openedFile,
    refreshRevision: refresh.refreshRevision,
    selectedPath: navigation.selectedPath,
    specialLocation: navigation.specialLocation,
    visibleRows,
    selectedEntry,
    refresh: refresh.refresh,
    selectEntry: navigation.selectEntry,
    navigate: navigation.navigate,
    navigateTrash: navigation.navigateTrash,
    replaceWithPath: navigation.replaceWithPath,
    replaceWithMovedDirectory: navigation.replaceWithMovedDirectory,
    replaceWithTrash: navigation.replaceWithTrash,
    goBack: navigation.goBack,
    goUp: navigation.goUp,
    openEntry: navigation.openEntry,
    openFile: navigation.openFile,
  };
});

function explorerConnectionKey(machine?: Machine): string {
  if (!machine) return "";
  return [
    machine.id,
    machine.baseUrl,
    machine.clientId ?? "",
    machine.clientSecret ?? "",
  ].join("\n");
}

function requireScopeValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not provided.`);
  return value;
}

function handleInvalidCredentials(
  machine: Machine,
  err: unknown,
  clearMachineCredentials: (machineId: string) => void,
  closeSession: () => void,
): boolean {
  if (!isInvalidCredentialsError(err)) return false;
  closeSession();
  clearMachineCredentials(machine.id);
  return true;
}

function explorerNavigationStorageKey(
  machineId: string | undefined,
  paneScopeId: string,
): string {
  return `rieul.explorer.navigation.${machineId ?? "none"}.${paneScopeId}.v2`;
}

export function copyExplorerNavigationState(
  machineId: string | undefined,
  sourcePaneScopeId: string,
  targetPaneScopeId: string,
) {
  try {
    const storage = globalThis.localStorage;
    const sourceKey = explorerNavigationStorageKey(
      machineId,
      sourcePaneScopeId,
    );
    const targetKey = explorerNavigationStorageKey(
      machineId,
      targetPaneScopeId,
    );
    const sourceValue = storage.getItem(sourceKey);
    if (sourceValue === null) {
      storage.removeItem(targetKey);
      return;
    }
    storage.setItem(targetKey, sourceValue);
  } catch {
    // Keep pane splitting usable even if persisted tab state cannot be copied.
  }
}

export function writeExplorerFileNavigationState(
  machineId: string | undefined,
  paneScopeId: string,
  currentPath: string | undefined,
  openedFile: FsEntry,
) {
  writeExplorerNavigationState(machineId, paneScopeId, {
    type: "file",
    directoryPath: currentPath,
    entry: openedFile,
  });
}

export function writeExplorerDirectoryNavigationState(
  machineId: string | undefined,
  paneScopeId: string,
  path: string,
) {
  writeExplorerNavigationState(machineId, paneScopeId, locationFromPath(path));
}

function writeExplorerNavigationState(
  machineId: string | undefined,
  paneScopeId: string,
  location: ExplorerLocation,
) {
  try {
    const storage = globalThis.localStorage;
    const targetKey = explorerNavigationStorageKey(machineId, paneScopeId);
    const state: ExplorerNavigationState = {
      history: [],
      location,
    };
    storage.setItem(targetKey, JSON.stringify(state));
  } catch {
    // Opening a path should still work even if persisted tab state is unavailable.
  }
}

function locationFromPath(path?: string): ExplorerLocation {
  return path ? { type: "directory", path } : { type: "root" };
}

function currentPathFromLocation(
  location: ExplorerLocation,
): string | undefined {
  if (location.type === "directory") return location.path;
  if (location.type === "file") return location.directoryPath;
  return undefined;
}

function directoryPathFromLocation(
  location: ExplorerLocation,
): string | undefined {
  if (location.type === "directory") return location.path;
  if (location.type === "file") return location.directoryPath;
  return undefined;
}

function displayPathFromLocation(
  location: ExplorerLocation,
): string | undefined {
  switch (location.type) {
    case "root":
      return undefined;
    case "directory":
      return location.path;
    case "file":
      return location.entry.path;
    case "trash":
      return trashLocationPath;
  }
}

function applyRootsEvent(
  event: RootsTableEvent,
  setRoots: Setter<FsEntry[]>,
  setRootsState: Setter<StreamState>,
) {
  if (event.type === "snapshot") {
    setRoots(event.rows);
    setRootsState({ phase: "live", message: "Roots live" });
    return;
  }
  if (event.type === "patch") {
    setRoots((current) =>
      applyEntryPatch(
        current,
        event.removes.map((item) => item.path),
        event.upserts,
      ),
    );
    setRootsState({ phase: "live", message: "Roots updated" });
    return;
  }
  setRootsState({
    phase: "closed",
    message: `Roots closed: ${subscriptionCloseReasonLabel(event.reason)}`,
  });
}

function applyDirectoryEvent(
  event: DirectoryTableEvent,
  setDirectoryRows: Setter<FsEntry[]>,
  setDirectoryState: Setter<StreamState>,
  onMoved: (path: string | undefined) => void,
) {
  if (event.type === "snapshot") {
    setDirectoryRows(event.rows);
    setDirectoryState({
      phase: "live",
      message: "Directory live",
    });
    return;
  }
  if (event.type === "patch") {
    setDirectoryRows((current) => {
      const removedNames = new Set(event.removes.map((item) => item.name));
      const remaining = current.filter(
        (entry) => !removedNames.has(entry.name),
      );
      const upsertNames = new Set(event.upserts.map((entry) => entry.name));
      return sortEntries([
        ...remaining.filter((entry) => !upsertNames.has(entry.name)),
        ...event.upserts,
      ]);
    });
    setDirectoryState({
      phase: "live",
      message: "Directory updated",
    });
    return;
  }
  if (event.reason.type === "moved") onMoved(event.reason.to);
  setDirectoryState({
    phase: "closed",
    message: `Directory closed: ${subscriptionCloseReasonLabel(event.reason)}`,
  });
}

function subscriptionCloseReasonLabel(
  reason: DirectorySubscriptionCloseReason | RootsSubscriptionCloseReason,
): string {
  return reason.type;
}

function applyEntryPatch(
  current: FsEntry[],
  removedPaths: string[],
  upserts: FsEntry[],
): FsEntry[] {
  const removed = new Set(removedPaths);
  const upsertPaths = new Set(upserts.map((entry) => entry.path));
  return sortEntries([
    ...current.filter(
      (entry) => !removed.has(entry.path) && !upsertPaths.has(entry.path),
    ),
    ...upserts,
  ]);
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((left, right) => {
    const leftRank = kindRank(left.kind);
    const rightRank = kindRank(right.kind);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return displayName(left).localeCompare(displayName(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function kindRank(kind: FsEntryKind): number {
  if (kind === FsEntryKind.Directory) return 0;
  if (kind === FsEntryKind.Symlink) return 1;
  if (kind === FsEntryKind.File) return 2;
  return 3;
}

export function pathCrumbs(path?: string): { label: string; path?: string }[] {
  if (!path) return [{ label: "Root" }];
  const { root, separator } = pathRoot(path);
  const crumbs = [{ label: "Root" }, { label: root, path: root }];
  const rest = path.slice(root.length).replace(/[\\/]+$/g, "");
  if (!rest) return crumbs;
  let cursor = root;
  for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
    cursor = cursor.endsWith(separator)
      ? `${cursor}${part}`
      : `${cursor}${separator}${part}`;
    crumbs.push({ label: part, path: cursor });
  }
  return crumbs;
}

function pathRoot(path: string): { root: string; separator: "\\" | "/" } {
  const drive = /^[A-Za-z]:[\\/]/.exec(path);
  if (drive) {
    const root = drive[0];
    return {
      root,
      separator: root.endsWith("/") ? "/" : "\\",
    };
  }
  const unc = /^\\\\[^\\]+\\[^\\]+\\?/.exec(path);
  if (unc) {
    const root = unc[0].endsWith("\\") ? unc[0] : `${unc[0]}\\`;
    return { root, separator: "\\" };
  }
  if (path.startsWith("/")) return { root: "/", separator: "/" };
  return { root: path, separator: path.includes("/") ? "/" : "\\" };
}

export function parentPath(path: string): string | undefined {
  const { root } = pathRoot(path);
  const trimmed = path.replace(/[\\/]+$/g, "");
  if (trimmed === root.replace(/[\\/]+$/g, "")) return undefined;
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) return undefined;
  if (index < root.length) return root;
  return trimmed.slice(0, index) || undefined;
}

export function displayName(entry: FsEntry): string {
  return entry.name.trim() || entry.path;
}

export function kindLabel(kind: FsEntryKind): string {
  switch (kind) {
    case FsEntryKind.File:
      return "File";
    case FsEntryKind.Directory:
      return "Directory";
    case FsEntryKind.Symlink:
      return "Link";
    case FsEntryKind.Other:
      return "Other";
  }
}

export function formatSize(size: number | undefined): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${
    units[unitIndex]
  }`;
}

export function formatDate(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
