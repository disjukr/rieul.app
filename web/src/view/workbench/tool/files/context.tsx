import { createContext, type Accessor } from "solid-js";
import type { Atom } from "jotai/vanilla";
import type { FsEntry } from "../../../../protocol/generated/rpc.ts";
import type {
  ExplorerLocation,
  ExplorerSpecialLocation,
} from "../../../../state/explorer.ts";
export interface FilesExplorerState {
  currentPathAtom: Atom<string | undefined>;
  displayPathAtom: Atom<string | undefined>;
  historyAtom: Atom<ExplorerLocation[]>;
  openedFileAtom: Atom<FsEntry | undefined>;
  refreshAtom: Atom<number>;
  selectedEntryAtom: Atom<FsEntry | undefined>;
  selectedPathAtom: Atom<string | undefined>;
  specialLocationAtom: Atom<ExplorerSpecialLocation | undefined>;
  visibleRowsAtom: Atom<FsEntry[]>;
  goBack: () => void;
  goUp: () => void;
  navigate: (path?: string) => void;
  navigateTrash: () => void;
  openEntry: (entry: FsEntry) => void;
  openFile: (entry: FsEntry) => void;
  replaceWithPath: (path?: string) => void;
  replaceWithMovedDirectory: (path?: string) => void;
  replaceWithTrash: () => void;
  refresh: () => void;
  selectEntry: (entry: FsEntry) => void;
}
export interface FilesActions {
  goBack: () => void;
  goUp: () => void;
  navigate: (path?: string) => void;
  openEntry: (entry: FsEntry) => void;
  openEntryMenu: (entry: FsEntry, event: MouseEvent) => void;
  openFolderMenu: (event: MouseEvent) => void;
  selectEntry: (entry: FsEntry) => void;
}
export interface FilesRenameState {
  draftName: string;
  entryPath?: string;
  error?: string;
  isRenaming: boolean;
  cancelRename: () => void;
  commitRename: (entry: FsEntry) => void;
  updateDraftName: (value: string) => void;
}
export interface FilesCreateFileState {
  draftName: string;
  error?: string;
  isCreating: boolean;
  isEditing: boolean;
  cancelCreate: () => void;
  commitCreate: () => void;
  updateDraftName: (value: string) => void;
}
export const FilesExplorerContext =
  createContext<Accessor<FilesExplorerState | undefined>>();
export const FilesActionsContext =
  createContext<Accessor<FilesActions | undefined>>();
export const FilesRenameContext =
  createContext<Accessor<FilesRenameState | undefined>>();
export const FilesCreateFileContext =
  createContext<Accessor<FilesCreateFileState | undefined>>();
export function requireFilesExplorer(
  explorer: Accessor<FilesExplorerState | undefined>,
): Accessor<FilesExplorerState> {
  return () => {
    const value = explorer();
    if (!value) throw new Error("Files explorer context is not provided.");
    return value;
  };
}
export function requireFilesActions(
  actions: Accessor<FilesActions | undefined>,
): Accessor<FilesActions> {
  return () => {
    const value = actions();
    if (!value) throw new Error("Files actions context is not provided.");
    return value;
  };
}
export function requireFilesRenameState(
  state: Accessor<FilesRenameState | undefined>,
): Accessor<FilesRenameState> {
  return () => {
    const value = state();
    if (!value) throw new Error("Files rename context is not provided.");
    return value;
  };
}
export function requireFilesCreateFileState(
  state: Accessor<FilesCreateFileState | undefined>,
): Accessor<FilesCreateFileState> {
  return () => {
    const value = state();
    if (!value) throw new Error("Files create-file context is not provided.");
    return value;
  };
}
