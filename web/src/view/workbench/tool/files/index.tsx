import React, { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { ArrowLeft, ArrowUp, HardDrive, Info, KeyRound } from "lucide-react";
import { FsEntry, FsEntryKind } from "../../../../protocol/rpc.ts";
import { connectionBunja } from "../../../../state/connection.ts";
import {
  explorerBunja,
  ExplorerPaneScope,
  formatSize,
} from "../../../../state/explorer.ts";
import { machineModalBunja } from "../../../../state/machine-modal.ts";
import { machineStoreBunja } from "../../../../state/machine-store.ts";
import { EntryPropertiesModal, Inspector } from "./entry-details.tsx";
import { FileOpenPrompt } from "./file-open-prompt.tsx";
import { FileTable } from "./file-table.tsx";
import { FileViewer } from "./file-viewer.tsx";
import { PathCrumbs } from "./path-crumbs.tsx";
import type { EntryMenuState } from "./types.ts";

const inlineFileOpenLimitBytes = 1024 * 1024;

interface FilesToolProps {
  paneScopeId: string;
}

export function FilesTool({ paneScopeId }: FilesToolProps) {
  const connectionState = useBunja(connectionBunja);
  const machineModal = useBunja(machineModalBunja);
  const machineStore = useBunja(machineStoreBunja);
  const machine = useAtomValue(machineStore.selectedAtom);
  const isPaired = useAtomValue(machineStore.selectedIsPairedAtom);
  const connectionEpoch = useAtomValue(connectionState.connectionEpochAtom);
  const explorer = useBunja(explorerBunja, [
    ExplorerPaneScope.bind(paneScopeId),
  ]);
  const currentPath = useAtomValue(explorer.currentPathAtom);
  const displayPath = useAtomValue(explorer.displayPathAtom);
  const history = useAtomValue(explorer.historyAtom);
  const openedFile = useAtomValue(explorer.openedFileAtom);
  const selectedPath = useAtomValue(explorer.selectedPathAtom);
  const visibleRows = useAtomValue(explorer.visibleRowsAtom);
  const selectedEntry = useAtomValue(explorer.selectedEntryAtom);
  const lastConnectionEpochRef = useRef(connectionEpoch);
  const [entryMenu, setEntryMenu] = useState<EntryMenuState>();
  const [propertiesEntry, setPropertiesEntry] = useState<FsEntry>();
  const [fileOpenPrompt, setFileOpenPrompt] = useState<FsEntry>();

  useEffect(() => {
    if (lastConnectionEpochRef.current === connectionEpoch) return;
    lastConnectionEpochRef.current = connectionEpoch;
    explorer.refresh();
  }, [connectionEpoch, explorer]);

  useEffect(() => {
    if (!entryMenu) return;

    function closeMenu() {
      setEntryMenu(undefined);
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
  }, [entryMenu]);

  useEffect(() => {
    if (!propertiesEntry) return;

    function closeModalOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPropertiesEntry(undefined);
    }

    globalThis.addEventListener("keydown", closeModalOnEscape);
    return () => globalThis.removeEventListener("keydown", closeModalOnEscape);
  }, [propertiesEntry]);

  const {
    goBack,
    goUp,
    navigate,
    openEntry,
    openFile,
    selectEntry,
  } = explorer;

  function goBackFromToolbar() {
    if (fileOpenPrompt) {
      setFileOpenPrompt(undefined);
      return;
    }
    goBack();
  }

  function goUpFromToolbar() {
    if (fileOpenPrompt) {
      setFileOpenPrompt(undefined);
      return;
    }
    goUp();
  }

  function navigateFromToolbar(path?: string) {
    if (fileOpenPrompt && path === fileOpenPrompt.path) return;
    setFileOpenPrompt(undefined);
    if (openedFile && path === openedFile.path) return;
    navigate(path);
  }

  function openTableEntry(entry: FsEntry) {
    if (entry.kind === FsEntryKind.Directory) {
      setFileOpenPrompt(undefined);
      openEntry(entry);
      return;
    }
    if (entry.kind !== FsEntryKind.File) {
      selectEntry(entry);
      return;
    }

    selectEntry(entry);
    if (
      entry.size === undefined ||
      entry.size > inlineFileOpenLimitBytes
    ) {
      setFileOpenPrompt(entry);
      return;
    }
    setFileOpenPrompt(undefined);
    openFile(entry);
  }

  function confirmFileOpen() {
    if (!fileOpenPrompt) return;
    openFile(fileOpenPrompt);
    setFileOpenPrompt(undefined);
  }

  function openEntryMenu(
    entry: FsEntry,
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    selectEntry(entry);
    setEntryMenu({ entry, x: event.clientX, y: event.clientY });
  }

  function openEntryProperties(entry: FsEntry) {
    setEntryMenu(undefined);
    setPropertiesEntry(entry);
  }

  if (!machine) {
    return (
      <section className="empty-workspace">
        <HardDrive size={28} />
        <h2>No machine selected</h2>
      </section>
    );
  }

  if (!isPaired) {
    return (
      <section className="empty-workspace">
        <KeyRound size={28} />
        <h2>Pairing required</h2>
        <button
          type="button"
          onClick={() => machineModal.openPairMachineModal(machine.id)}
        >
          <KeyRound size={16} />
          Pair
        </button>
      </section>
    );
  }

  return (
    <section className="explorer">
      <div className="path-toolbar">
        <button
          type="button"
          onClick={goBackFromToolbar}
          disabled={history.length === 0 && !fileOpenPrompt}
          title="Back"
          aria-label="Back"
          className="icon-button"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          onClick={goUpFromToolbar}
          disabled={!currentPath}
          title="Up"
          aria-label="Up"
          className="icon-button"
        >
          <ArrowUp size={16} />
        </button>
        <PathCrumbs
          path={fileOpenPrompt?.path ?? displayPath}
          onNavigate={navigateFromToolbar}
        />
      </div>

      {fileOpenPrompt
        ? (
          <FileOpenPrompt
            file={fileOpenPrompt}
            onCancel={() => setFileOpenPrompt(undefined)}
            onConfirm={confirmFileOpen}
          />
        )
        : openedFile
        ? <FileViewer machine={machine} file={openedFile} />
        : (
          <div className="browser-layout">
            <FileTable
              rows={visibleRows}
              selectedPath={selectedPath}
              onSelect={selectEntry}
              onOpen={openTableEntry}
              onContextMenu={openEntryMenu}
            />
            <Inspector entry={selectedEntry} currentPath={currentPath} />
          </div>
        )}

      <div className="explorer-footer">
        <span>
          {fileOpenPrompt
            ? formatSize(fileOpenPrompt.size)
            : openedFile
            ? formatSize(openedFile.size)
            : `${visibleRows.length} items`}
        </span>
      </div>

      {entryMenu
        ? (
          <div
            className="entry-context-menu"
            style={{ left: entryMenu.x, top: entryMenu.y }}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => openEntryProperties(entryMenu.entry)}
            >
              <Info size={15} />
              Properties
            </button>
          </div>
        )
        : null}

      {propertiesEntry
        ? (
          <EntryPropertiesModal
            entry={propertiesEntry}
            onClose={() => setPropertiesEntry(undefined)}
          />
        )
        : null}
    </section>
  );
}
