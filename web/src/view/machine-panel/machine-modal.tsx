import React, { FormEvent } from "react";
import { KeyRound, Loader2, RefreshCw, Settings, Trash2 } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { MachineModalMode } from "../../state/types.ts";
import { Button } from "../ui/button.tsx";
import { ModalDialog } from "../ui/dialog.tsx";
import { TextField } from "../ui/field.tsx";
import { Surface } from "../ui/surface.tsx";
import { AddMachineForm } from "./add-machine-form.tsx";

const machineModalFormClassName = "grid gap-[0.5rem] p-[16px]";
const modalMachineSummaryClassName = [
  "grid gap-[0.5rem] p-[10px]",
  "[&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis",
  "[&_strong]:whitespace-nowrap [&_strong]:text-[var(--wgo-text-primary)] [&_strong]:text-[13px]",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis",
  "[&_span]:whitespace-nowrap [&_span]:text-[var(--wgo-text-tertiary)] [&_span]:text-[12px]",
].join(" ");
const fieldErrorClassName = "text-[var(--wgo-danger)] text-[12px]";
const modalActionsClassName = "flex justify-end gap-[0.5rem]";
const modalWarningClassName =
  "m-0 text-[var(--wgo-text-secondary)] text-[13px]";
const pairingControlClassName = [
  "flex items-center justify-between gap-[0.5rem] rounded-[8px]",
  "border border-[var(--wgo-border-light)] bg-[var(--wgo-bg-secondary)] px-[10px] py-[8px]",
].join(" ");
const pairingStepClassName = [
  "grid min-h-[174px] place-items-center gap-[0.5rem] rounded-[8px]",
  "border border-[var(--wgo-border-light)] bg-[var(--wgo-bg-primary)] px-[16px] py-[18px] text-center",
].join(" ");
const confirmationCodeClassName = [
  "grid h-[96px] min-w-[156px] place-items-center rounded-[8px]",
  "border border-[var(--wgo-border-control-muted)] bg-[var(--wgo-bg-secondary)] px-[18px]",
  "font-800 text-[var(--wgo-text-primary)] text-[56px] leading-none tracking-[0]",
].join(" ");

interface MachineModalProps {
  baseUrl: string;
  configNameDraft: string;
  configNameInputRef: React.RefObject<HTMLInputElement | null>;
  configUrlDraft: string;
  isRequestingPairingCode: boolean;
  isPairing: boolean;
  machineCount: number;
  machineFormError: string;
  machineName: string;
  machineNameInputRef: React.RefObject<HTMLInputElement | null>;
  mode: MachineModalMode;
  modalTitle: string;
  pairingCode: string;
  pairingConfirmationCode?: string;
  pairingCodeExpiresInSeconds?: number;
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
  onRequestPairingCode: () => void;
  onSaveMachineConfig: (event: FormEvent<HTMLFormElement>) => void;
}

interface PairMachineFormProps {
  isRequestingPairingCode: boolean;
  isPairing: boolean;
  pairingCode: string;
  pairingConfirmationCode?: string;
  pairingCodeExpiresInSeconds?: number;
  pairingCodeInputRef: React.RefObject<HTMLInputElement | null>;
  selected: Machine;
  onClose: () => void;
  onPairingCodeChange: (value: string) => void;
  onRequestPairingCode: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

interface PairingRestartControlProps {
  disabled: boolean;
  machineName: string;
  onRequestPairingCode: () => void;
}

interface PairingConfirmationStepProps {
  confirmationCode?: string;
  isRequestingPairingCode: boolean;
}

interface PairingCodeStepProps {
  pairingCode: string;
  pairingCodeExpiresInSeconds?: number;
  pairingCodeInputRef: React.RefObject<HTMLInputElement | null>;
  onPairingCodeChange: (value: string) => void;
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
    isRequestingPairingCode,
    isPairing,
    machineCount,
    machineFormError,
    machineName,
    machineNameInputRef,
    mode,
    modalTitle,
    pairingCode,
    pairingConfirmationCode,
    pairingCodeExpiresInSeconds,
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
    onRequestPairingCode,
    onSaveMachineConfig,
  }: MachineModalProps,
) {
  return (
    <ModalDialog
      eyebrow="Machine"
      title={modalTitle}
      titleId="machine-modal-title"
      showClose={machineCount > 0}
      onClose={onClose}
    >
      {mode === "pair" && selected
        ? (
          <PairMachineForm
            isRequestingPairingCode={isRequestingPairingCode}
            isPairing={isPairing}
            pairingCode={pairingCode}
            pairingConfirmationCode={pairingConfirmationCode}
            pairingCodeExpiresInSeconds={pairingCodeExpiresInSeconds}
            pairingCodeInputRef={pairingCodeInputRef}
            selected={selected}
            onClose={onClose}
            onPairingCodeChange={onPairingCodeChange}
            onRequestPairingCode={onRequestPairingCode}
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
    </ModalDialog>
  );
}

function PairMachineForm(
  {
    isRequestingPairingCode,
    isPairing,
    pairingCode,
    pairingConfirmationCode,
    pairingCodeExpiresInSeconds,
    pairingCodeInputRef,
    selected,
    onClose,
    onPairingCodeChange,
    onRequestPairingCode,
    onSubmit,
  }: PairMachineFormProps,
) {
  const hasPairingCode = pairingCodeExpiresInSeconds !== undefined;
  return (
    <form className={machineModalFormClassName} onSubmit={onSubmit}>
      <PairingRestartControl
        disabled={isPairing}
        machineName={selected.name}
        onRequestPairingCode={onRequestPairingCode}
      />
      {hasPairingCode
        ? (
          <PairingCodeStep
            pairingCode={pairingCode}
            pairingCodeExpiresInSeconds={pairingCodeExpiresInSeconds}
            pairingCodeInputRef={pairingCodeInputRef}
            onPairingCodeChange={onPairingCodeChange}
          />
        )
        : (
          <PairingConfirmationStep
            confirmationCode={pairingConfirmationCode}
            isRequestingPairingCode={isRequestingPairingCode}
          />
        )}
      <div className={modalActionsClassName}>
        <Button onClick={onClose}>
          Skip
        </Button>
        {hasPairingCode
          ? (
            <Button
              type="submit"
              disabled={isPairing || isRequestingPairingCode ||
                pairingCode.length === 0}
            >
              {isPairing
                ? <Loader2 size={16} className="animate-spin" />
                : <KeyRound size={16} />}
              Pair
            </Button>
          )
          : null}
      </div>
    </form>
  );
}

function PairingRestartControl(
  {
    disabled,
    machineName,
    onRequestPairingCode,
  }: PairingRestartControlProps,
) {
  return (
    <div className={pairingControlClassName}>
      <span className="flex min-w-0 items-center gap-[0.5rem] text-[var(--wgo-text-secondary)] text-[12px]">
        <span className="shrink-0">Pairing to</span>
        <strong className="min-w-0 truncate font-700 text-[var(--wgo-text-primary)]">
          {machineName}
        </strong>
      </span>
      <Button
        className="min-w-[36px] px-[10px]"
        disabled={disabled}
        onClick={onRequestPairingCode}
        title="Restart pairing"
      >
        <RefreshCw size={16} />
        Restart pairing
      </Button>
    </div>
  );
}

function PairingConfirmationStep(
  { confirmationCode, isRequestingPairingCode }: PairingConfirmationStepProps,
) {
  return (
    <section className={pairingStepClassName}>
      <div className="grid justify-items-center gap-[0.5rem]">
        <span className="text-[var(--wgo-text-secondary)] text-[12px] font-700">
          Confirmation code
        </span>
        <div className={confirmationCodeClassName}>
          {confirmationCode ?? "--"}
        </div>
      </div>
      <p className="m-0 max-w-[320px] text-[var(--wgo-text-tertiary)] text-[13px] leading-[1.45]">
        Select this code on the daemon to reveal the pairing code.
      </p>
      {isRequestingPairingCode
        ? (
          <div className="flex items-center gap-[0.5rem] text-[var(--wgo-text-secondary)] text-[12px]">
            <Loader2 size={14} className="animate-spin" />
            Waiting for confirmation
          </div>
        )
        : null}
    </section>
  );
}

function PairingCodeStep(
  {
    pairingCode,
    pairingCodeExpiresInSeconds,
    pairingCodeInputRef,
    onPairingCodeChange,
  }: PairingCodeStepProps,
) {
  return (
    <section className={pairingStepClassName}>
      <TextField
        ref={pairingCodeInputRef}
        className="w-full"
        label="Pairing code"
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
      {pairingCodeExpiresInSeconds !== undefined
        ? pairingCodeExpiresInSeconds <= 0
          ? (
            <p className="m-0 text-[var(--wgo-danger)] text-[12px]">
              Pairing code expired. Restart pairing.
            </p>
          )
          : (
            <p className="m-0 text-[var(--wgo-text-tertiary)] text-[12px]">
              Pairing code expires in{" "}
              {formatRemainingTime(pairingCodeExpiresInSeconds)}.
            </p>
          )
        : null}
    </section>
  );
}

function formatRemainingTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutesPart = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secondsPart = (seconds % 60).toString().padStart(2, "0");
  return `${minutesPart}:${secondsPart}`;
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
      className={machineModalFormClassName}
      onSubmit={onSubmit}
    >
      <Surface
        border="subtle"
        radius="lg"
        variant="secondary"
        className={modalMachineSummaryClassName}
      >
        <strong>{selected.name}</strong>
        <span>{selected.baseUrl}</span>
      </Surface>
      <TextField
        ref={configNameInputRef}
        label="Name"
        value={configNameDraft}
        onChange={(event) => onConfigNameChange(event.target.value)}
        placeholder="Machine name"
        aria-label="Machine name"
      />
      <TextField
        label="URL"
        value={configUrlDraft}
        onChange={(event) => onConfigUrlChange(event.target.value)}
        placeholder="https://host:9012"
        aria-label="Machine URL"
      />
      {error ? <div className={fieldErrorClassName}>{error}</div> : null}
      <div className={modalActionsClassName}>
        <Button onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">
          <Settings size={16} />
          Save
        </Button>
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
    <div className={machineModalFormClassName}>
      <Surface
        border="subtle"
        radius="lg"
        variant="secondary"
        className={modalMachineSummaryClassName}
      >
        <strong>{selected.name}</strong>
        <span>{selected.baseUrl}</span>
      </Surface>
      <p className={modalWarningClassName}>
        This removes the machine from this browser.
      </p>
      <div className={modalActionsClassName}>
        <Button onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="danger"
          variant="soft"
          onClick={onDelete}
        >
          <Trash2 size={16} />
          Delete
        </Button>
      </div>
    </div>
  );
}
