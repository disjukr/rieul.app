import React, { createContext, FormEvent, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  createStore,
  Provider as JotaiProvider,
  useAtomValue,
  useSetAtom,
} from "jotai";
import { bindScope, BunjaStoreProvider, useBunja } from "bunja/react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileQuestion,
  FileText,
  Folder,
  HardDrive,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import "./styles.css";
import { FsEntry, FsEntryKind } from "./protocol/rpc.ts";
import { connectionBunja } from "./state/connection.ts";
import {
  displayName,
  explorerBunja,
  ExplorerMachineScope,
  formatDate,
  formatSize,
  kindLabel,
  pathCrumbs,
} from "./state/explorer.ts";
import { type JotaiStore, JotaiStoreScope } from "./state/jotai-store.ts";
import { machineMenuBunja } from "./state/machine-menu.ts";
import { machineModalBunja } from "./state/machine-modal.ts";
import { machineStoreBunja } from "./state/machine-store.ts";
import { Machine } from "./state/machines.ts";
import { ConnectionState, StreamState } from "./state/types.ts";

const jotaiStore = createStore();
const JotaiStoreContext = createContext<JotaiStore>(jotaiStore);
bindScope(JotaiStoreScope, JotaiStoreContext);
const projectLogoUrl = new URL("./assets/wgo.svg", import.meta.url).href;

function App() {
  const machineStore = useBunja(machineStoreBunja);
  const machineMenuState = useBunja(machineMenuBunja);
  const machineModal = useBunja(machineModalBunja);
  const connectionState = useBunja(connectionBunja);

  const machines = useAtomValue(machineStore.machinesAtom);
  const selected = useAtomValue(machineStore.selectedAtom);
  const selectedId = useAtomValue(machineStore.selectedIdAtom);
  const selectedIsPaired = useAtomValue(machineStore.selectedIsPairedAtom);
  const machineName = useAtomValue(machineModal.machineNameAtom);
  const baseUrl = useAtomValue(machineModal.baseUrlAtom);
  const configNameDraft = useAtomValue(machineModal.configNameDraftAtom);
  const configUrlDraft = useAtomValue(machineModal.configUrlDraftAtom);
  const machineModalMode = useAtomValue(machineModal.machineModalModeAtom);
  const machineFormError = useAtomValue(machineModal.machineFormErrorAtom);
  const pairingCode = useAtomValue(machineModal.pairingCodeAtom);
  const isPairing = useAtomValue(machineModal.isPairingAtom);
  const machineMenu = useAtomValue(machineMenuState.machineMenuAtom);
  const menuMachine = useAtomValue(machineMenuState.menuMachineAtom);
  const railTooltip = useAtomValue(machineMenuState.railTooltipAtom);
  const connection = useAtomValue(connectionState.connectionAtom);
  const connectionEpoch = useAtomValue(connectionState.connectionEpochAtom);
  const modalTitle = useAtomValue(machineModal.modalTitleAtom);
  const setConfigNameDraft = useSetAtom(machineModal.configNameDraftAtom);
  const setConfigUrlDraft = useSetAtom(machineModal.configUrlDraftAtom);
  const setPairingCode = useSetAtom(machineModal.pairingCodeAtom);
  const machineNameInputRef = useRef<HTMLInputElement>(null);
  const configNameInputRef = useRef<HTMLInputElement>(null);
  const pairingCodeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (machines.length === 0 && !machineModalMode) {
      machineNameInputRef.current?.focus();
    }
  }, [machineModalMode, machines.length]);

  useEffect(() => {
    if (machineModalMode === "add") {
      machineNameInputRef.current?.focus();
      return;
    }
    if (machineModalMode === "pair") {
      pairingCodeInputRef.current?.focus();
      return;
    }
    if (machineModalMode === "config") {
      configNameInputRef.current?.focus();
      configNameInputRef.current?.select();
    }
  }, [machineModalMode]);

  useEffect(() => {
    if (!machineModalMode || machines.length === 0) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMachineModal();
      }
    }

    globalThis.addEventListener("keydown", closeOnEscape);
    return () => globalThis.removeEventListener("keydown", closeOnEscape);
  }, [machineModalMode, machines.length]);

  useEffect(() => {
    if (!machineMenu) return;

    function closeMenu() {
      machineMenuState.closeMachineMenu();
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
  }, [machineMenuState, machineMenu]);

  function addMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    machineModal.addMachine();
  }

  function closeMachineModal() {
    machineModal.closeMachineModal();
  }

  function openAddMachineModal() {
    machineModal.openAddMachineModal();
    if (machines.length === 0) {
      machineNameInputRef.current?.focus();
    }
  }

  function openMachineContextMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    machineMenuState.openMachineMenu(machine.id, event.clientX, event.clientY);
  }

  function openMachineTitleMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    machineMenuState.openMachineMenu(machine.id, rect.left, rect.bottom + 8);
  }

  function showRailTooltip(target: HTMLElement, name: string) {
    const rect = target.getBoundingClientRect();
    machineMenuState.showRailTooltip(
      name,
      rect.right + 12,
      rect.top + rect.height / 2,
    );
  }

  function openConfigMachineModal(machine: Machine) {
    machineModal.openConfigMachineModal(machine.id);
  }

  function openPairMachineModal(machine: Machine) {
    machineModal.openPairMachineModal(machine.id);
  }

  function openDeleteMachineModal(machine: Machine) {
    machineModal.openDeleteMachineModal(machine.id);
  }

  function saveMachineConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    machineModal.saveMachineConfig();
  }

  function deleteSelectedMachine() {
    machineModal.deleteSelectedMachine();
  }

  async function checkSelected() {
    await connectionState.checkSelected();
  }

  async function pairSelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await machineModal.pairSelected(
      `web:${globalThis.location.host || "local"}`,
    );
  }

  function updateMachineNameDraft(value: string) {
    machineModal.updateMachineNameDraft(value);
  }

  function updateBaseUrlDraft(value: string) {
    machineModal.updateBaseUrlDraft(value);
  }

  function renderAddMachineForm(showCancel: boolean) {
    return (
      <form className="machine-modal-form" onSubmit={addMachine}>
        <label>
          <span>Name</span>
          <input
            ref={machineNameInputRef}
            value={machineName}
            onChange={(event) => updateMachineNameDraft(event.target.value)}
            placeholder="Local daemon"
            aria-label="Machine name"
          />
        </label>
        <label>
          <span>URL</span>
          <input
            value={baseUrl}
            onChange={(event) => updateBaseUrlDraft(event.target.value)}
            placeholder="https://host:8765"
            aria-label="Machine URL"
          />
        </label>
        {machineFormError
          ? <div className="field-error">{machineFormError}</div>
          : null}
        <div className="modal-actions">
          {showCancel
            ? (
              <button type="button" onClick={closeMachineModal}>
                Cancel
              </button>
            )
            : null}
          <button type="submit">
            <Plus size={16} />
            Continue
          </button>
        </div>
      </form>
    );
  }

  return (
    <main className="app-shell">
      <aside className="machine-rail" aria-label="Machine switcher">
        <div className="rail-brand" title="wgo">
          <img src={projectLogoUrl} alt="wgo" />
        </div>

        <nav className="rail-list" aria-label="Machines">
          {machines.map((machine) => (
            <button
              type="button"
              key={machine.id}
              className={machine.id === selectedId
                ? "rail-machine active"
                : "rail-machine"}
              onClick={() => {
                machineMenuState.selectMachine(machine.id);
              }}
              onMouseEnter={(event) =>
                showRailTooltip(event.currentTarget, machine.name)}
              onMouseLeave={machineMenuState.hideRailTooltip}
              onFocus={(event) =>
                showRailTooltip(event.currentTarget, machine.name)}
              onBlur={machineMenuState.hideRailTooltip}
              onContextMenu={(event) => openMachineContextMenu(event, machine)}
              aria-label={machine.name}
            >
              <span className="rail-indicator" />
              <span className="machine-avatar">
                {machineInitials(machine.name)}
              </span>
              <span
                className={machine.clientId && machine.clientSecret
                  ? "rail-dot paired"
                  : "rail-dot"}
              />
            </button>
          ))}
        </nav>

        <button
          type="button"
          className="rail-action"
          onClick={openAddMachineModal}
          title="Add machine"
          aria-label="Add machine"
        >
          <Plus size={22} />
        </button>
      </aside>

      {railTooltip
        ? (
          <div
            className="rail-tooltip"
            style={{ left: railTooltip.x, top: railTooltip.y }}
            role="tooltip"
          >
            {railTooltip.name}
          </div>
        )
        : null}

      <section
        className={machines.length === 0 ? "workspace no-machine" : "workspace"}
      >
        {machines.length > 0
          ? (
            <header className="topbar">
              <div className="machine-title">
                <h1>
                  {selected
                    ? (
                      <button
                        type="button"
                        className="machine-title-button"
                        onClick={(event) =>
                          openMachineTitleMenu(event, selected)}
                        title="Machine actions"
                        aria-label={`${selected.name} machine actions`}
                      >
                        <span className="machine-title-text">
                          {selected.name}
                        </span>
                        <ChevronDown size={16} />
                      </button>
                    )
                    : "No machine"}
                </h1>
              </div>
              <div className="topbar-actions">
                <StatusPill connection={connection} paired={selectedIsPaired} />
                <button
                  type="button"
                  onClick={() => void checkSelected()}
                  disabled={!selected}
                  title="Check"
                  aria-label="Check"
                  className="icon-button"
                >
                  <RefreshCw size={16} />
                </button>
              </div>
            </header>
          )
          : null}

        {machines.length === 0
          ? (
            <section className="inline-machine-setup">
              <div className="inline-machine-card">
                <header className="modal-head">
                  <div>
                    <span>Machine</span>
                    <h2>Add machine</h2>
                  </div>
                </header>
                {renderAddMachineForm(false)}
              </div>
            </section>
          )
          : (
            <Explorer
              machine={selected}
              isPaired={selectedIsPaired}
              connectionEpoch={connectionEpoch}
              onPair={() => selected && openPairMachineModal(selected)}
            />
          )}
      </section>

      {machineMenu && menuMachine
        ? (
          <div
            className="machine-context-menu"
            style={{ left: machineMenu.x, top: machineMenu.y }}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => openConfigMachineModal(menuMachine)}
            >
              <Settings size={15} />
              Configure
            </button>
            {!(menuMachine.clientId && menuMachine.clientSecret)
              ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openPairMachineModal(menuMachine)}
                >
                  <KeyRound size={15} />
                  Pair
                </button>
              )
              : null}
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => openDeleteMachineModal(menuMachine)}
            >
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        )
        : null}

      {machineModalMode
        ? (
          <div
            className="modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                closeMachineModal();
              }
            }}
          >
            <section
              className="machine-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="machine-modal-title"
            >
              <header className="modal-head">
                <div>
                  <span>Machine</span>
                  <h2 id="machine-modal-title">{modalTitle}</h2>
                </div>
                {machines.length > 0
                  ? (
                    <button
                      type="button"
                      onClick={closeMachineModal}
                      title="Close"
                      aria-label="Close machine modal"
                      className="icon-button"
                    >
                      <X size={16} />
                    </button>
                  )
                  : null}
              </header>

              {machineModalMode === "pair" && selected
                ? (
                  <form className="machine-modal-form" onSubmit={pairSelected}>
                    <div className="modal-machine-summary">
                      <strong>{selected.name}</strong>
                      <span>{selected.baseUrl}</span>
                    </div>
                    <label>
                      <span>Pairing code</span>
                      <input
                        ref={pairingCodeInputRef}
                        value={pairingCode}
                        onChange={(event) =>
                          setPairingCode(
                            event.target.value.replace(/\D/g, "").slice(0, 6),
                          )}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        placeholder="000000"
                        aria-label="Pairing code"
                      />
                    </label>
                    {connection.phase === "offline"
                      ? <div className="field-error">{connection.message}</div>
                      : null}
                    <div className="modal-actions">
                      <button type="button" onClick={closeMachineModal}>
                        Skip
                      </button>
                      <button
                        type="submit"
                        disabled={isPairing || pairingCode.length === 0}
                      >
                        {isPairing
                          ? <Loader2 size={16} className="spin" />
                          : <KeyRound size={16} />}
                        Pair
                      </button>
                    </div>
                  </form>
                )
                : machineModalMode === "config" && selected
                ? (
                  <form
                    className="machine-modal-form"
                    onSubmit={saveMachineConfig}
                  >
                    <div className="modal-machine-summary">
                      <strong>{selected.name}</strong>
                      <span>{selected.baseUrl}</span>
                    </div>
                    <label>
                      <span>Name</span>
                      <input
                        ref={configNameInputRef}
                        value={configNameDraft}
                        onChange={(event) =>
                          setConfigNameDraft(event.target.value)}
                        placeholder="Machine name"
                        aria-label="Machine name"
                      />
                    </label>
                    <label>
                      <span>URL</span>
                      <input
                        value={configUrlDraft}
                        onChange={(event) =>
                          setConfigUrlDraft(event.target.value)}
                        placeholder="https://host:8765"
                        aria-label="Machine URL"
                      />
                    </label>
                    {machineFormError
                      ? <div className="field-error">{machineFormError}</div>
                      : null}
                    <div className="modal-actions">
                      <button type="button" onClick={closeMachineModal}>
                        Cancel
                      </button>
                      <button type="submit">
                        <Settings size={16} />
                        Save
                      </button>
                    </div>
                  </form>
                )
                : machineModalMode === "delete" && selected
                ? (
                  <div className="machine-modal-form">
                    <div className="modal-machine-summary">
                      <strong>{selected.name}</strong>
                      <span>{selected.baseUrl}</span>
                    </div>
                    <p className="modal-warning">
                      This removes the machine from this browser.
                    </p>
                    <div className="modal-actions">
                      <button type="button" onClick={closeMachineModal}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        onClick={deleteSelectedMachine}
                      >
                        <Trash2 size={16} />
                        Delete
                      </button>
                    </div>
                  </div>
                )
                : (
                  renderAddMachineForm(true)
                )}
            </section>
          </div>
        )
        : null}
    </main>
  );
}

function machineInitials(name: string): string {
  const letters = name
    .split(/[\s._-]+/)
    .map((part) => part.trim()[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "PC";
}

function StatusPill(
  { connection, paired }: { connection: ConnectionState; paired: boolean },
) {
  const Icon = connection.phase === "reachable"
    ? Wifi
    : connection.phase === "offline"
    ? WifiOff
    : connection.phase === "checking"
    ? Loader2
    : AlertCircle;
  return (
    <div className={`status-pill ${connection.phase}`}>
      <Icon
        size={15}
        className={connection.phase === "checking" ? "spin" : ""}
      />
      <span>{paired ? "Paired" : "Unpaired"}</span>
      <span>{connection.message}</span>
    </div>
  );
}

function Explorer(
  { machine, isPaired, connectionEpoch, onPair }: {
    machine?: Machine;
    isPaired: boolean;
    connectionEpoch: number;
    onPair: () => void;
  },
) {
  const explorer = useBunja(explorerBunja, [
    ExplorerMachineScope.bind(machine?.id),
  ]);
  const currentPath = useAtomValue(explorer.currentPathAtom);
  const history = useAtomValue(explorer.historyAtom);
  const selectedPath = useAtomValue(explorer.selectedPathAtom);
  const filter = useAtomValue(explorer.filterAtom);
  const visibleRows = useAtomValue(explorer.visibleRowsAtom);
  const selectedEntry = useAtomValue(explorer.selectedEntryAtom);
  const streamState = useAtomValue(explorer.streamStateAtom);
  const lastConnectionEpochRef = useRef(connectionEpoch);

  useEffect(() => {
    if (lastConnectionEpochRef.current === connectionEpoch) return;
    lastConnectionEpochRef.current = connectionEpoch;
    explorer.refresh();
  }, [connectionEpoch, explorer]);

  const {
    goBack,
    goUp,
    navigate,
    openEntry,
    selectEntry,
    setFilter,
  } = explorer;

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
          onClick={goBack}
          disabled={history.length === 0}
          title="Back"
          aria-label="Back"
          className="icon-button"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          onClick={goUp}
          disabled={!currentPath}
          title="Up"
          aria-label="Up"
          className="icon-button"
        >
          <ArrowUp size={16} />
        </button>
        <PathCrumbs path={currentPath} onNavigate={navigate} />
        <label className="search-box">
          <Search size={15} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter"
            aria-label="Filter files"
          />
        </label>
      </div>

      <div className="stream-line">
        <StreamBadge state={streamState} />
        <span>{visibleRows.length} rows</span>
      </div>

      <div className="browser-layout">
        <FileTable
          rows={visibleRows}
          selectedPath={selectedPath}
          onSelect={selectEntry}
          onOpen={openEntry}
        />
        <Inspector entry={selectedEntry} currentPath={currentPath} />
      </div>
    </section>
  );
}

function PathCrumbs(
  { path, onNavigate }: {
    path?: string;
    onNavigate: (path?: string) => void;
  },
) {
  const crumbs = pathCrumbs(path);
  return (
    <div className="crumbs" aria-label="Path">
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

function StreamBadge({ state }: { state: StreamState }) {
  const Icon = state.phase === "live"
    ? CheckCircle2
    : state.phase === "connecting"
    ? Loader2
    : state.phase === "error"
    ? AlertCircle
    : state.phase === "closed"
    ? X
    : AlertCircle;
  return (
    <span className={`stream-badge ${state.phase}`}>
      <Icon size={14} className={state.phase === "connecting" ? "spin" : ""} />
      {state.message}
    </span>
  );
}

function FileTable(
  {
    rows,
    selectedPath,
    onSelect,
    onOpen,
  }: {
    rows: FsEntry[];
    selectedPath?: string;
    onSelect: (entry: FsEntry) => void;
    onOpen: (entry: FsEntry) => void;
  },
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
  { entry, currentPath }: { entry?: FsEntry; currentPath?: string },
) {
  return (
    <aside className="inspector">
      <div className="inspector-title">Selection</div>
      {entry
        ? (
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
        )
        : (
          <dl>
            <dt>Location</dt>
            <dd>{currentPath ?? "Roots"}</dd>
          </dl>
        )}
    </aside>
  );
}

function EntryIcon({ entry }: { entry: FsEntry }) {
  if (entry.kind === FsEntryKind.Directory) {
    return entry.path.endsWith("\\")
      ? <HardDrive size={16} />
      : <Folder size={16} />;
  }
  if (entry.kind === FsEntryKind.Symlink) return <Link2 size={16} />;
  if (entry.kind === FsEntryKind.File) return <FileText size={16} />;
  return <FileQuestion size={16} />;
}

createRoot(document.getElementById("root")!).render(
  <JotaiProvider store={jotaiStore}>
    <JotaiStoreContext.Provider value={jotaiStore}>
      <BunjaStoreProvider>
        <App />
      </BunjaStoreProvider>
    </JotaiStoreContext.Provider>
  </JotaiProvider>,
);
