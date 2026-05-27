import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
import {
  checkReachable,
  completePairing,
  DirectoryTableEvent,
  FsEntry,
  FsEntryKind,
  isDatagramPingTimeoutError,
  RootsTableEvent,
  subscribeDirectory,
  subscribeRoots,
} from "./protocol/rpc.ts";
import {
  loadMachines,
  Machine,
  normalizeMachineUrl,
  saveMachines,
} from "./state/machines.ts";

type ConnectionState =
  | { phase: "idle"; message: string }
  | { phase: "checking"; message: string }
  | { phase: "reachable"; message: string; latencyMs: number }
  | { phase: "offline"; message: string };

type StreamState =
  | { phase: "idle"; message: string }
  | { phase: "connecting"; message: string }
  | { phase: "live"; message: string }
  | { phase: "closed"; message: string }
  | { phase: "error"; message: string };

type MachineModalMode = "add" | "pair" | "config" | "delete";
type MachineMenuState = { machineId: string; x: number; y: number };
type RailTooltipState = { name: string; x: number; y: number };

const STATUS_PING_INTERVAL_MS = 5_000;
const initialMachines = loadMachines();
const projectLogoUrl = new URL("./assets/wgo.svg", import.meta.url).href;

function App() {
  const [machines, setMachines] = useState<Machine[]>(() => initialMachines);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialMachines[0]?.id ?? null
  );
  const [machineName, setMachineName] = useState("");
  const [machineNameEdited, setMachineNameEdited] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [configNameDraft, setConfigNameDraft] = useState("");
  const [configUrlDraft, setConfigUrlDraft] = useState("");
  const [machineModalMode, setMachineModalMode] = useState<
    MachineModalMode | null
  >(null);
  const [machineFormError, setMachineFormError] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [machineMenu, setMachineMenu] = useState<MachineMenuState | null>(null);
  const [railTooltip, setRailTooltip] = useState<RailTooltipState | null>(null);
  const machineNameInputRef = useRef<HTMLInputElement>(null);
  const configNameInputRef = useRef<HTMLInputElement>(null);
  const pairingCodeInputRef = useRef<HTMLInputElement>(null);
  const [connection, setConnection] = useState<ConnectionState>({
    phase: "idle",
    message: "No machine selected",
  });
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const connectionReachableRef = useRef(false);
  const selected = useMemo(
    () => machines.find((machine) => machine.id === selectedId) ?? null,
    [machines, selectedId],
  );
  const selectedIsPaired = Boolean(
    selected?.clientId && selected?.clientSecret,
  );
  const menuMachine = useMemo(
    () =>
      machines.find((machine) => machine.id === machineMenu?.machineId) ??
        null,
    [machines, machineMenu?.machineId],
  );
  const modalTitle = machineModalTitle(machineModalMode);

  useEffect(() => {
    saveMachines(machines);
  }, [machines]);

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
      setMachineMenu(null);
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
  }, [machineMenu]);

  useEffect(() => {
    if (!selected) {
      connectionReachableRef.current = false;
      setConnection({ phase: "idle", message: "No machine selected" });
      return;
    }

    const currentMachine = selected;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function pingStatus(showChecking: boolean) {
      if (showChecking) {
        setConnection({ phase: "checking", message: "Checking transport" });
      }
      try {
        const latencyMs = await checkReachable(currentMachine);
        if (stopped) return;
        markConnectionReachable(formatLatency(latencyMs), latencyMs);
      } catch (err) {
        if (stopped) return;
        if (isDatagramPingTimeoutError(err)) {
          setConnection((current) =>
            current.phase === "reachable"
              ? { ...current, message: "No pong" }
              : { phase: "checking", message: "No pong" }
          );
          return;
        }
        markConnectionOffline(connectionErrorMessage(err, currentMachine));
      } finally {
        if (!stopped) {
          timer = setTimeout(
            () => void pingStatus(false),
            STATUS_PING_INTERVAL_MS,
          );
        }
      }
    }

    void pingStatus(true);

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    selected?.id,
    selected?.baseUrl,
    selected?.clientId,
    selected?.clientSecret,
  ]);

  function markConnectionReachable(message: string, latencyMs: number) {
    if (!connectionReachableRef.current) {
      setConnectionEpoch((current) => current + 1);
    }
    connectionReachableRef.current = true;
    setConnection({ phase: "reachable", message, latencyMs });
  }

  function markConnectionOffline(message: string) {
    connectionReachableRef.current = false;
    setConnection({ phase: "offline", message });
  }

  function addMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMachineFormError("");
    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeMachineUrl(baseUrl);
    } catch (err) {
      setMachineFormError(errorMessage(err));
      return;
    }

    const machine: Machine = {
      id: crypto.randomUUID(),
      name: machineName.trim() || inferMachineNameFromUrl(normalizedBaseUrl),
      baseUrl: normalizedBaseUrl,
    };
    setMachines((current) => [...current, machine]);
    setSelectedId(machine.id);
    setMachineName("");
    setMachineNameEdited(false);
    setBaseUrl("");
    setPairingCode("");
    setMachineModalMode("pair");
  }

  function closeMachineModal() {
    if (machines.length === 0) return;
    setMachineModalMode(null);
    setMachineFormError("");
    setPairingCode("");
  }

  function openAddMachineModal() {
    setMachineMenu(null);
    setMachineName("");
    setMachineNameEdited(false);
    setBaseUrl("");
    setMachineFormError("");
    setPairingCode("");
    if (machines.length === 0) {
      setMachineModalMode(null);
      machineNameInputRef.current?.focus();
      return;
    }
    setMachineModalMode("add");
  }

  function openMachineContextMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setRailTooltip(null);
    openMachineMenu(machine, event.clientX, event.clientY);
  }

  function openMachineTitleMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    machine: Machine,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openMachineMenu(machine, rect.left, rect.bottom + 8);
  }

  function openMachineMenu(machine: Machine, x: number, y: number) {
    setRailTooltip(null);
    setSelectedId(machine.id);
    setMachineMenu({
      machineId: machine.id,
      x: Math.max(8, Math.min(x, globalThis.innerWidth - 190)),
      y: Math.max(8, Math.min(y, globalThis.innerHeight - 150)),
    });
  }

  function showRailTooltip(target: HTMLElement, name: string) {
    const rect = target.getBoundingClientRect();
    setRailTooltip({
      name,
      x: rect.right + 12,
      y: rect.top + rect.height / 2,
    });
  }

  function openConfigMachineModal(machine: Machine) {
    setSelectedId(machine.id);
    setConfigNameDraft(machine.name);
    setConfigUrlDraft(machine.baseUrl);
    setMachineFormError("");
    setMachineMenu(null);
    setMachineModalMode("config");
  }

  function openPairMachineModal(machine: Machine) {
    setSelectedId(machine.id);
    setPairingCode("");
    setMachineFormError("");
    setMachineMenu(null);
    setMachineModalMode("pair");
  }

  function openDeleteMachineModal(machine: Machine) {
    setSelectedId(machine.id);
    setMachineFormError("");
    setMachineMenu(null);
    setMachineModalMode("delete");
  }

  function saveMachineConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const name = configNameDraft.trim();
    if (!name) {
      setMachineFormError("Name is required");
      return;
    }
    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeMachineUrl(configUrlDraft);
    } catch (err) {
      setMachineFormError(errorMessage(err));
      return;
    }
    setMachines((current) =>
      current.map((machine) =>
        machine.id === selected.id
          ? { ...machine, name, baseUrl: normalizedBaseUrl }
          : machine
      )
    );
    setMachineFormError("");
    setMachineModalMode(null);
  }

  function deleteSelectedMachine() {
    if (!selected) return;
    const deletedId = selected.id;
    const remaining = machines.filter((machine) => machine.id !== deletedId);
    setMachines(remaining);
    setSelectedId((current) =>
      current === deletedId ? remaining[0]?.id ?? null : current
    );
    setMachineFormError("");
    setPairingCode("");
    setMachineModalMode(null);
  }

  async function checkSelected() {
    if (!selected) return;
    setConnection({ phase: "checking", message: "Checking transport" });
    try {
      const latencyMs = await checkReachable(selected);
      markConnectionReachable(formatLatency(latencyMs), latencyMs);
    } catch (err) {
      if (isDatagramPingTimeoutError(err)) {
        setConnection((current) =>
          current.phase === "reachable"
            ? { ...current, message: "No pong" }
            : { phase: "checking", message: "No pong" }
        );
        return;
      }
      markConnectionOffline(connectionErrorMessage(err, selected));
    }
  }

  async function pairSelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || isPairing) return;
    const code = pairingCode.trim();
    if (!code) return;
    setIsPairing(true);
    setConnection({ phase: "checking", message: "Pairing" });
    try {
      const credentials = await completePairing(
        selected,
        code,
        `web:${globalThis.location.host || "local"}`,
      );
      setMachines((current) =>
        current.map((machine) =>
          machine.id === selected.id
            ? {
              ...machine,
              clientId: credentials.clientId,
              clientSecret: credentials.clientSecret,
            }
            : machine
        )
      );
      setPairingCode("");
      markConnectionReachable("Paired", 0);
      setMachineModalMode(null);
    } catch (err) {
      setConnection({
        phase: "offline",
        message: connectionErrorMessage(err, selected),
      });
    } finally {
      setIsPairing(false);
    }
  }

  function updateMachineNameDraft(value: string) {
    setMachineName(value);
    setMachineNameEdited(value.trim().length > 0);
  }

  function updateBaseUrlDraft(value: string) {
    setBaseUrl(value);
    if (!machineNameEdited) {
      setMachineName(inferMachineNameFromUrl(value));
    }
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
                setRailTooltip(null);
                setMachineMenu(null);
                setSelectedId(machine.id);
              }}
              onMouseEnter={(event) =>
                showRailTooltip(event.currentTarget, machine.name)}
              onMouseLeave={() => setRailTooltip(null)}
              onFocus={(event) =>
                showRailTooltip(event.currentTarget, machine.name)}
              onBlur={() => setRailTooltip(null)}
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

function machineModalTitle(mode: MachineModalMode | null): string {
  switch (mode) {
    case "pair":
      return "Pair machine";
    case "config":
      return "Machine config";
    case "delete":
      return "Delete machine";
    case "add":
    case null:
      return "Add machine";
  }
}

function inferMachineNameFromUrl(raw: string): string {
  try {
    const hostname = new URL(normalizeMachineUrl(raw)).hostname;
    const firstLabel = hostname.split(".")[0] ?? "";
    if (hostname.includes(".") && /[a-z]/i.test(firstLabel)) {
      return firstLabel;
    }
    return hostname;
  } catch {
    return "";
  }
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
    machine: Machine | null;
    isPaired: boolean;
    connectionEpoch: number;
    onPair: () => void;
  },
) {
  const [roots, setRoots] = useState<FsEntry[]>([]);
  const [directoryRows, setDirectoryRows] = useState<FsEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [rootsState, setRootsState] = useState<StreamState>({
    phase: "idle",
    message: "Roots idle",
  });
  const [directoryState, setDirectoryState] = useState<StreamState>({
    phase: "idle",
    message: "Directory idle",
  });

  useEffect(() => {
    setRoots([]);
    setDirectoryRows([]);
    setCurrentPath(null);
    setHistory([]);
    setSelectedPath(null);
    setFilter("");
    setRootsState({ phase: "idle", message: "Roots idle" });
    setDirectoryState({ phase: "idle", message: "Directory idle" });
  }, [machine?.id]);

  useEffect(() => {
    if (!machine || !isPaired) return;

    let cancelled = false;
    const iterator = subscribeRoots(machine);
    setRootsState({ phase: "connecting", message: "Opening roots" });
    void (async () => {
      try {
        for await (const event of iterator) {
          if (cancelled) break;
          applyRootsEvent(event, setRoots, setRootsState);
        }
      } catch (err) {
        if (!cancelled) {
          setRootsState({ phase: "error", message: errorMessage(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
      void iterator.return(undefined);
    };
  }, [
    machine?.id,
    machine?.baseUrl,
    machine?.clientId,
    machine?.clientSecret,
    isPaired,
    connectionEpoch,
  ]);

  useEffect(() => {
    setDirectoryRows([]);
    setSelectedPath(null);
    if (!machine || !isPaired || !currentPath) {
      setDirectoryState({ phase: "idle", message: "Directory idle" });
      return;
    }

    let cancelled = false;
    const iterator = subscribeDirectory(machine, currentPath);
    setDirectoryState({ phase: "connecting", message: "Opening directory" });
    void (async () => {
      try {
        for await (const event of iterator) {
          if (cancelled) break;
          applyDirectoryEvent(
            event,
            setDirectoryRows,
            setDirectoryState,
            (path) => {
              if (path) {
                setCurrentPath(path);
                setHistory([]);
              }
            },
          );
        }
      } catch (err) {
        if (!cancelled) {
          setDirectoryState({ phase: "error", message: errorMessage(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
      void iterator.return(undefined);
    };
  }, [
    machine?.id,
    machine?.baseUrl,
    machine?.clientId,
    machine?.clientSecret,
    isPaired,
    currentPath,
    connectionEpoch,
  ]);

  const rows = currentPath ? directoryRows : roots;
  const visibleRows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const sorted = sortEntries(rows);
    if (!query) return sorted;
    return sorted.filter((entry) =>
      displayName(entry).toLowerCase().includes(query) ||
      entry.path.toLowerCase().includes(query)
    );
  }, [rows, filter]);
  const selectedEntry = useMemo(
    () => rows.find((entry) => entry.path === selectedPath) ?? null,
    [rows, selectedPath],
  );
  const streamState = currentPath ? directoryState : rootsState;

  function navigate(path: string | null) {
    setHistory((current) => [...current, currentPath]);
    setCurrentPath(path);
    setSelectedPath(null);
  }

  function goBack() {
    setHistory((current) => {
      if (current.length === 0) return current;
      const next = current[current.length - 1] ?? null;
      setCurrentPath(next);
      setSelectedPath(null);
      return current.slice(0, -1);
    });
  }

  function goUp() {
    if (!currentPath) return;
    navigate(parentPath(currentPath));
  }

  function openEntry(entry: FsEntry) {
    if (entry.kind === FsEntryKind.Directory) {
      navigate(entry.path);
    } else {
      setSelectedPath(entry.path);
    }
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
          onSelect={(entry) => setSelectedPath(entry.path)}
          onOpen={openEntry}
        />
        <Inspector entry={selectedEntry} currentPath={currentPath} />
      </div>
    </section>
  );
}

function PathCrumbs(
  { path, onNavigate }: {
    path: string | null;
    onNavigate: (path: string | null) => void;
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
    selectedPath: string | null;
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
  { entry, currentPath }: { entry: FsEntry | null; currentPath: string | null },
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

function applyRootsEvent(
  event: RootsTableEvent,
  setRoots: React.Dispatch<React.SetStateAction<FsEntry[]>>,
  setState: React.Dispatch<React.SetStateAction<StreamState>>,
) {
  if (event.type === "snapshot") {
    setRoots(event.rows);
    setState({ phase: "live", message: "Roots live" });
    return;
  }
  if (event.type === "patch") {
    setRoots((current) =>
      applyEntryPatch(
        current,
        event.removes.map((item) => item.path),
        event.upserts,
      )
    );
    setState({ phase: "live", message: "Roots updated" });
    return;
  }
  setState({ phase: "closed", message: `Roots closed: ${event.reason}` });
}

function applyDirectoryEvent(
  event: DirectoryTableEvent,
  setRows: React.Dispatch<React.SetStateAction<FsEntry[]>>,
  setState: React.Dispatch<React.SetStateAction<StreamState>>,
  onMoved: (path: string | undefined) => void,
) {
  if (event.type === "snapshot") {
    setRows(event.rows);
    setState({ phase: "live", message: "Directory live" });
    return;
  }
  if (event.type === "patch") {
    setRows((current) => {
      const removedNames = new Set(event.removes.map((item) => item.name));
      const remaining = current.filter((entry) =>
        !removedNames.has(entry.name)
      );
      const upsertNames = new Set(event.upserts.map((entry) => entry.name));
      return sortEntries([
        ...remaining.filter((entry) => !upsertNames.has(entry.name)),
        ...event.upserts,
      ]);
    });
    setState({ phase: "live", message: "Directory updated" });
    return;
  }
  if (event.reason === "Moved") onMoved(event.to);
  setState({ phase: "closed", message: `Directory closed: ${event.reason}` });
}

function applyEntryPatch(
  current: FsEntry[],
  removedPaths: string[],
  upserts: FsEntry[],
): FsEntry[] {
  const removed = new Set(removedPaths);
  const upsertPaths = new Set(upserts.map((entry) => entry.path));
  return sortEntries([
    ...current.filter((entry) =>
      !removed.has(entry.path) && !upsertPaths.has(entry.path)
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

function pathCrumbs(
  path: string | null,
): { label: string; path: string | null }[] {
  if (!path) return [{ label: "Roots", path: null }];
  const root = rootPath(path);
  const crumbs = [
    { label: "Roots", path: null },
    { label: root, path: root },
  ];
  const rest = path.slice(root.length).replace(/[\\/]+$/g, "");
  if (!rest) return crumbs;
  let cursor = root;
  for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
    cursor = cursor.endsWith("\\") ? `${cursor}${part}` : `${cursor}\\${part}`;
    crumbs.push({ label: part, path: cursor });
  }
  return crumbs;
}

function rootPath(path: string): string {
  const drive = /^[A-Za-z]:\\/.exec(path);
  if (drive) return drive[0];
  const unc = /^\\\\[^\\]+\\[^\\]+\\?/.exec(path);
  if (unc) return unc[0].endsWith("\\") ? unc[0] : `${unc[0]}\\`;
  return path;
}

function parentPath(path: string): string | null {
  const root = rootPath(path);
  const trimmed = path.replace(/[\\/]+$/g, "");
  if (trimmed === root.replace(/[\\/]+$/g, "")) return null;
  const index = trimmed.lastIndexOf("\\");
  if (index < 0) return null;
  if (index < root.length) return root;
  return trimmed.slice(0, index) || null;
}

function displayName(entry: FsEntry): string {
  return entry.name.trim() || entry.path;
}

function kindLabel(kind: FsEntryKind): string {
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

function formatSize(size: number | undefined): string {
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

function formatDate(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function formatLatency(latencyMs: number): string {
  return `${Math.max(1, Math.round(latencyMs))}ms`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function connectionErrorMessage(err: unknown, machine: Machine | null): string {
  const message = errorMessage(err);
  if (!message.toLowerCase().includes("handshake")) return message;

  const host = machine ? safeHost(machine.baseUrl) : "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "WebTransport TLS handshake failed. Use the daemon URL printed by the pairing command; localhost will fail when the daemon certificate is issued for another host.";
  }
  return "WebTransport TLS handshake failed. Check that the daemon URL matches a trusted certificate host.";
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

createRoot(document.getElementById("root")!).render(<App />);
