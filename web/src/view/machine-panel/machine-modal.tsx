import React, { FormEvent } from "react";
import { KeyRound, Loader2, Settings, Trash2, X } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState, MachineModalMode } from "../../state/types.ts";
import { AddMachineForm } from "./add-machine-form.tsx";

interface MachineModalProps {
  baseUrl: string;
  configNameDraft: string;
  configNameInputRef: React.RefObject<HTMLInputElement | null>;
  configUrlDraft: string;
  connection: ConnectionState;
  isPairing: boolean;
  machineCount: number;
  machineFormError: string;
  machineName: string;
  machineNameInputRef: React.RefObject<HTMLInputElement | null>;
  mode: MachineModalMode;
  modalTitle: string;
  pairingCode: string;
  pairingCodeInputRef: React.RefObject<HTMLInputElement | null>;
  selected?: Machine;
  onAddMachine: (event: FormEvent<HTMLFormElement>) => void;
  onBaseUrlChange: (value: string) => void;
  onClose: () => void;
  onConfigNameChange: (value: string) => void;
  onConfigUrlChange: (value: string) => void;
  onDeleteSelectedMachine: () => void;
  onMachineNameChange: (value: string) => void;
  onPairingCodeChange: (value: string) => void;
  onPairSelected: (event: FormEvent<HTMLFormElement>) => void;
  onSaveMachineConfig: (event: FormEvent<HTMLFormElement>) => void;
}

interface PairMachineFormProps {
  connection: ConnectionState;
  isPairing: boolean;
  pairingCode: string;
  pairingCodeInputRef: React.RefObject<HTMLInputElement | null>;
  selected: Machine;
  onClose: () => void;
  onPairingCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

interface MachineConfigFormProps {
  configNameDraft: string;
  configNameInputRef: React.RefObject<HTMLInputElement | null>;
  configUrlDraft: string;
  error: string;
  selected: Machine;
  onClose: () => void;
  onConfigNameChange: (value: string) => void;
  onConfigUrlChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

interface DeleteMachineFormProps {
  selected: Machine;
  onClose: () => void;
  onDelete: () => void;
}

export function MachineModal(
  {
    baseUrl,
    configNameDraft,
    configNameInputRef,
    configUrlDraft,
    connection,
    isPairing,
    machineCount,
    machineFormError,
    machineName,
    machineNameInputRef,
    mode,
    modalTitle,
    pairingCode,
    pairingCodeInputRef,
    selected,
    onAddMachine,
    onBaseUrlChange,
    onClose,
    onConfigNameChange,
    onConfigUrlChange,
    onDeleteSelectedMachine,
    onMachineNameChange,
    onPairingCodeChange,
    onPairSelected,
    onSaveMachineConfig,
  }: MachineModalProps,
) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
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
          {machineCount > 0
            ? (
              <button
                type="button"
                onClick={onClose}
                title="Close"
                aria-label="Close machine modal"
                className="icon-button"
              >
                <X size={16} />
              </button>
            )
            : null}
        </header>

        {mode === "pair" && selected
          ? (
            <PairMachineForm
              connection={connection}
              isPairing={isPairing}
              pairingCode={pairingCode}
              pairingCodeInputRef={pairingCodeInputRef}
              selected={selected}
              onClose={onClose}
              onPairingCodeChange={onPairingCodeChange}
              onSubmit={onPairSelected}
            />
          )
          : mode === "config" && selected
          ? (
            <MachineConfigForm
              configNameDraft={configNameDraft}
              configNameInputRef={configNameInputRef}
              configUrlDraft={configUrlDraft}
              error={machineFormError}
              selected={selected}
              onClose={onClose}
              onConfigNameChange={onConfigNameChange}
              onConfigUrlChange={onConfigUrlChange}
              onSubmit={onSaveMachineConfig}
            />
          )
          : mode === "delete" && selected
          ? (
            <DeleteMachineForm
              selected={selected}
              onClose={onClose}
              onDelete={onDeleteSelectedMachine}
            />
          )
          : (
            <AddMachineForm
              baseUrl={baseUrl}
              error={machineFormError}
              machineName={machineName}
              machineNameInputRef={machineNameInputRef}
              showCancel
              onBaseUrlChange={onBaseUrlChange}
              onCancel={onClose}
              onMachineNameChange={onMachineNameChange}
              onSubmit={onAddMachine}
            />
          )}
      </section>
    </div>
  );
}

function PairMachineForm(
  {
    connection,
    isPairing,
    pairingCode,
    pairingCodeInputRef,
    selected,
    onClose,
    onPairingCodeChange,
    onSubmit,
  }: PairMachineFormProps,
) {
  return (
    <form className="machine-modal-form" onSubmit={onSubmit}>
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
            onPairingCodeChange(
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
        <button type="button" onClick={onClose}>
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
  );
}

function MachineConfigForm(
  {
    configNameDraft,
    configNameInputRef,
    configUrlDraft,
    error,
    selected,
    onClose,
    onConfigNameChange,
    onConfigUrlChange,
    onSubmit,
  }: MachineConfigFormProps,
) {
  return (
    <form
      className="machine-modal-form"
      onSubmit={onSubmit}
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
          onChange={(event) => onConfigNameChange(event.target.value)}
          placeholder="Machine name"
          aria-label="Machine name"
        />
      </label>
      <label>
        <span>URL</span>
        <input
          value={configUrlDraft}
          onChange={(event) => onConfigUrlChange(event.target.value)}
          placeholder="https://host:8765"
          aria-label="Machine URL"
        />
      </label>
      {error ? <div className="field-error">{error}</div> : null}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit">
          <Settings size={16} />
          Save
        </button>
      </div>
    </form>
  );
}

function DeleteMachineForm(
  {
    selected,
    onClose,
    onDelete,
  }: DeleteMachineFormProps,
) {
  return (
    <div className="machine-modal-form">
      <div className="modal-machine-summary">
        <strong>{selected.name}</strong>
        <span>{selected.baseUrl}</span>
      </div>
      <p className="modal-warning">
        This removes the machine from this browser.
      </p>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="danger-action"
          onClick={onDelete}
        >
          <Trash2 size={16} />
          Delete
        </button>
      </div>
    </div>
  );
}
