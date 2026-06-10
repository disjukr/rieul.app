import React, { FormEvent, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  FileQuestion,
  FileText,
  Folder,
  HardDrive,
  Info,
  KeyRound,
  Link2,
  Loader2,
  X,
} from "lucide-react";
import { FsEntry, FsEntryKind, readFile } from "../../protocol/rpc.ts";
import {
  displayName,
  explorerBunja,
  ExplorerMachineScope,
  ExplorerPaneScope,
  formatDate,
  formatSize,
  kindLabel,
  pathCrumbs,
} from "../../state/explorer.ts";
import type { Machine } from "../../state/machines.ts";

const inlineFileOpenLimitBytes = 1024 * 1024;

interface EntryMenuState {
  entry: FsEntry;
  x: number;
  y: number;
}

type FilePreview =
  | { kind: "text"; text: string }
  | { kind: "binary"; text: string };

type FileLoadState =
  | { phase: "loading" }
  | { phase: "ready"; byteLength: number; preview: FilePreview }
  | { phase: "error"; message: string };

interface ExplorerProps {
  paneScopeId: string;
  machine?: Machine;
  isPaired: boolean;
  connectionEpoch: number;
  onPair: () => void;
}

interface FileViewerProps {
  machine: Machine;
  file: FsEntry;
}

interface FileOpenPromptProps {
  file: FsEntry;
  onCancel: () => void;
  onConfirm: () => void;
}

interface PathCrumbsProps {
  path?: string;
  onNavigate: (path?: string) => void;
}

interface FileTableProps {
  rows: FsEntry[];
  selectedPath?: string;
  onSelect: (entry: FsEntry) => void;
  onOpen: (entry: FsEntry) => void;
  onContextMenu: (
    entry: FsEntry,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
}

interface InspectorProps {
  entry?: FsEntry;
  currentPath?: string;
}

interface EntryPropertiesModalProps {
  entry: FsEntry;
  onClose: () => void;
}

interface EntryDetailsProps {
  entry?: FsEntry;
  currentPath?: string;
}

interface EntryIconProps {
  entry: FsEntry;
}

export function Explorer(
  { paneScopeId, machine, isPaired, connectionEpoch, onPair }: ExplorerProps,
) {
  const explorer = useBunja(explorerBunja, [
    ExplorerMachineScope.bind(machine?.id),
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
        <button type="button" onClick={onPair}>
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

function FileViewer({ machine, file }: FileViewerProps) {
  const [state, setState] = useState<FileLoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    void (async () => {
      try {
        const bytes = await readFile(machine, file.path);
        if (cancelled) return;
        setState({
          phase: "ready",
          byteLength: bytes.byteLength,
          preview: decodeFilePreview(bytes),
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
  }, [file.path, machine]);

  return (
    <section className="file-viewer">
      <header className="file-viewer-head">
        <div className="file-viewer-title">
          <FileText size={16} />
          <span>{displayName(file)}</span>
        </div>
        <span className="file-viewer-meta">
          {state.phase === "ready"
            ? formatSize(state.byteLength)
            : formatSize(file.size)}
        </span>
      </header>
      {state.phase === "loading"
        ? (
          <div className="file-viewer-status">
            <Loader2 size={18} className="spin" />
            <span>Loading file</span>
          </div>
        )
        : state.phase === "error"
        ? (
          <div className="file-viewer-status error">
            <span>{state.message}</span>
          </div>
        )
        : (
          <pre
            className={state.preview.kind === "binary"
              ? "file-content binary"
              : "file-content"}
          >
            {state.preview.text}
          </pre>
        )}
    </section>
  );
}

function FileOpenPrompt(
  { file, onCancel, onConfirm }: FileOpenPromptProps,
) {
  const sizeLabel = file.size === undefined
    ? "Unknown size"
    : formatSize(file.size);

  return (
    <section className="file-open-prompt">
      <div className="file-open-prompt-panel">
        <div className="file-open-prompt-icon">
          <FileText size={24} />
        </div>
        <div className="file-open-prompt-copy">
          <h2>{displayName(file)}</h2>
          <p>
            This file is <strong>{sizeLabel}</strong>. Do you want to open it?
          </p>
          <p>{file.path}</p>
        </div>
        <div className="file-open-prompt-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm}>
            <FileText size={16} />
            Open
          </button>
        </div>
      </div>
    </section>
  );
}

function decodeFilePreview(bytes: Uint8Array): FilePreview {
  if (looksBinary(bytes)) {
    return { kind: "binary", text: hexPreview(bytes) };
  }

  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { kind: "binary", text: hexPreview(bytes) };
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    const isTextControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isTextControl) controls++;
  }
  return sample.length > 0 && controls / sample.length > 0.08;
}

function hexPreview(bytes: Uint8Array): string {
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
        byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."
      )
      .join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (bytes.length > previewLength) {
    lines.push(`... ${formatSize(bytes.length - previewLength)} more`);
  }
  return lines.join("\n");
}

function PathCrumbs(
  { path, onNavigate }: PathCrumbsProps,
) {
  const [editing, setEditing] = useState(false);
  const [draftPath, setDraftPath] = useState(path ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const crumbs = pathCrumbs(path);

  useEffect(() => {
    if (!editing) setDraftPath(path ?? "");
  }, [editing, path]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (editing) return;
    const element = crumbsRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.scrollLeft = element.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, path]);

  function beginEditing() {
    setDraftPath(path ?? "");
    setEditing(true);
  }

  function cancelEditing() {
    setDraftPath(path ?? "");
    setEditing(false);
  }

  function submitPath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextPath = draftPath.trim();
    setEditing(false);
    onNavigate(nextPath || undefined);
  }

  if (editing) {
    return (
      <form className="path-input-form" onSubmit={submitPath}>
        <input
          ref={inputRef}
          value={draftPath}
          onChange={(event) => setDraftPath(event.target.value)}
          onBlur={cancelEditing}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelEditing();
          }}
          aria-label="Path"
          placeholder="Path"
        />
      </form>
    );
  }

  return (
    <div
      ref={crumbsRef}
      className="crumbs"
      aria-label="Path"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        beginEditing();
      }}
    >
      {crumbs.map((crumb, index) => (
        <React.Fragment key={`${crumb.path ?? "roots"}:${index}`}>
          {index > 0 ? <ChevronRight size={14} /> : null}
          <button
            type="button"
            onClick={() =>
              onNavigate(crumb.path)}
          >
            {crumb.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

function FileTable(
  {
    rows,
    selectedPath,
    onSelect,
    onOpen,
    onContextMenu,
  }: FileTableProps,
) {
  return (
    <div className="file-table" role="grid" aria-label="Files">
      <div className="file-head name">Name</div>
      <div className="file-head kind">Kind</div>
      <div className="file-head size">Size</div>
      <div className="file-head modified">Modified</div>
      {rows.length === 0 ? <div className="table-empty">No rows</div> : (
        rows.map((entry) => (
          <button
            type="button"
            key={entry.path}
            className={entry.path === selectedPath
              ? "file-row selected"
              : "file-row"}
            onClick={() => onSelect(entry)}
            onDoubleClick={() => onOpen(entry)}
            onContextMenu={(event) => onContextMenu(entry, event)}
          >
            <span className="file-cell name">
              <EntryIcon entry={entry} />
              <span>{displayName(entry)}</span>
              {entry.readonly
                ? <span className="readonly">readonly</span>
                : null}
            </span>
            <span className="file-cell kind">{kindLabel(entry.kind)}</span>
            <span className="file-cell size">{formatSize(entry.size)}</span>
            <span className="file-cell modified">
              {formatDate(entry.modifiedAtMs)}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function Inspector(
  { entry, currentPath }: InspectorProps,
) {
  return (
    <aside className="inspector">
      <div className="inspector-title">Selection</div>
      <EntryDetails entry={entry} currentPath={currentPath} />
    </aside>
  );
}

function EntryPropertiesModal(
  { entry, onClose }: EntryPropertiesModalProps,
) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="machine-modal entry-properties-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-properties-title"
      >
        <header className="modal-head">
          <div>
            <span>File</span>
            <h2 id="entry-properties-title">Properties</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close properties modal"
            className="icon-button"
          >
            <X size={16} />
          </button>
        </header>

        <div className="entry-properties-body">
          <EntryDetails entry={entry} />
        </div>
      </section>
    </div>
  );
}

function EntryDetails(
  { entry, currentPath }: EntryDetailsProps,
) {
  if (!entry) {
    return (
      <dl>
        <dt>Location</dt>
        <dd>{currentPath ?? "Files"}</dd>
      </dl>
    );
  }

  return (
    <dl>
      <dt>Name</dt>
      <dd>{displayName(entry)}</dd>
      <dt>Path</dt>
      <dd>{entry.path}</dd>
      <dt>Kind</dt>
      <dd>{kindLabel(entry.kind)}</dd>
      <dt>Size</dt>
      <dd>{formatSize(entry.size)}</dd>
      <dt>Modified</dt>
      <dd>{formatDate(entry.modifiedAtMs)}</dd>
      <dt>Flags</dt>
      <dd>{entry.readonly ? "Readonly" : "Writable"}</dd>
    </dl>
  );
}

function EntryIcon({ entry }: EntryIconProps) {
  if (entry.kind === FsEntryKind.Directory) {
    return entry.path.endsWith("\\")
      ? <HardDrive size={16} />
      : <Folder size={16} />;
  }
  if (entry.kind === FsEntryKind.Symlink) return <Link2 size={16} />;
  if (entry.kind === FsEntryKind.File) return <FileText size={16} />;
  return <FileQuestion size={16} />;
}
