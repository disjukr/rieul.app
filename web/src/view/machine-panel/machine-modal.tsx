import { style, theme } from "../../zyzz.config.ts";
import { createMemo } from "solid-js";

import {
  KeyRound,
  Loader2,
  RefreshCw,
  Settings,
  Trash2,
} from "../../solid/icons.tsx";
import type { Machine } from "../../state/machines.ts";
import type { MachineModalMode } from "../../state/types.ts";
import { Button } from "../ui/button.tsx";
import { ModalDialog } from "../ui/dialog.tsx";
import { AddMachineForm } from "./add-machine-form.tsx";

interface MachineModalProps {
  baseUrl: string;
  configNameDraft: string;
  configNameInputRef: { current: HTMLInputElement | null };
  configUrlDraft: string;
  isRequestingPairingCode: boolean;
  isPairing: boolean;
  machineCount: number;
  machineFormError: string;
  machineName: string;
  machineNameInputRef: { current: HTMLInputElement | null };
  mode: MachineModalMode;
  modalTitle: string;
  pairingCode: string;
  pairingConfirmationCode?: string;
  pairingCodeExpiresInSeconds?: number;
  pairingCodeInputRef: { current: HTMLInputElement | null };
  selected?: Machine;
  onAddMachine: (
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ) => void;
  onBaseUrlChange: (value: string) => void;
  onClose: () => void;
  onConfigNameChange: (value: string) => void;
  onConfigUrlChange: (value: string) => void;
  onDeleteSelectedMachine: () => void;
  onMachineNameChange: (value: string) => void;
  onPairingCodeChange: (value: string) => void;
  onPairSelected: (
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ) => void;
  onRequestPairingCode: () => void;
  onSaveMachineConfig: (
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ) => void;
}

interface PairMachineFormProps {
  isRequestingPairingCode: boolean;
  isPairing: boolean;
  pairingCode: string;
  pairingConfirmationCode?: string;
  pairingCodeExpiresInSeconds?: number;
  pairingCodeInputRef: { current: HTMLInputElement | null };
  selected: Machine;
  onClose: () => void;
  onPairingCodeChange: (value: string) => void;
  onRequestPairingCode: () => void;
  onSubmit: (event: SubmitEvent & { currentTarget: HTMLFormElement }) => void;
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
  pairingCodeInputRef: { current: HTMLInputElement | null };
  onPairingCodeChange: (value: string) => void;
}

interface MachineConfigFormProps {
  configNameDraft: string;
  configNameInputRef: { current: HTMLInputElement | null };
  configUrlDraft: string;
  error: string;
  selected: Machine;
  onClose: () => void;
  onConfigNameChange: (value: string) => void;
  onConfigUrlChange: (value: string) => void;
  onSubmit: (event: SubmitEvent & { currentTarget: HTMLFormElement }) => void;
}

interface DeleteMachineFormProps {
  selected: Machine;
  onClose: () => void;
  onDelete: () => void;
}

export function MachineModal(componentProps: MachineModalProps) {
  return (
    <ModalDialog
      eyebrow="Machine"
      showClose={
        componentProps.machineCount > 0 || componentProps.mode === "add"
      }
      title={componentProps.modalTitle}
      titleId="machine-modal-title"
      onClose={() => componentProps.onClose()}
    >
      {componentProps.mode === "pair" && componentProps.selected ? (
        <PairMachineForm
          isRequestingPairingCode={componentProps.isRequestingPairingCode}
          isPairing={componentProps.isPairing}
          pairingCode={componentProps.pairingCode}
          pairingConfirmationCode={componentProps.pairingConfirmationCode}
          pairingCodeExpiresInSeconds={
            componentProps.pairingCodeExpiresInSeconds
          }
          pairingCodeInputRef={componentProps.pairingCodeInputRef}
          selected={componentProps.selected}
          onClose={() => componentProps.onClose()}
          onPairingCodeChange={(event) =>
            componentProps.onPairingCodeChange(event)
          }
          onRequestPairingCode={() => componentProps.onRequestPairingCode()}
          onSubmit={(event) => componentProps.onPairSelected(event)}
        />
      ) : componentProps.mode === "config" && componentProps.selected ? (
        <MachineConfigForm
          configNameDraft={componentProps.configNameDraft}
          configNameInputRef={componentProps.configNameInputRef}
          configUrlDraft={componentProps.configUrlDraft}
          error={componentProps.machineFormError}
          selected={componentProps.selected}
          onClose={() => componentProps.onClose()}
          onConfigNameChange={(event) =>
            componentProps.onConfigNameChange(event)
          }
          onConfigUrlChange={(event) => componentProps.onConfigUrlChange(event)}
          onSubmit={(event) => componentProps.onSaveMachineConfig(event)}
        />
      ) : componentProps.mode === "delete" && componentProps.selected ? (
        <DeleteMachineForm
          selected={componentProps.selected}
          onClose={() => componentProps.onClose()}
          onDelete={() => componentProps.onDeleteSelectedMachine()}
        />
      ) : (
        <AddMachineForm
          baseUrl={componentProps.baseUrl}
          error={componentProps.machineFormError}
          machineName={componentProps.machineName}
          machineNameInputRef={componentProps.machineNameInputRef}
          showCancel
          onBaseUrlChange={(event) => componentProps.onBaseUrlChange(event)}
          onCancel={() => componentProps.onClose()}
          onMachineNameChange={(event) =>
            componentProps.onMachineNameChange(event)
          }
          onSubmit={(event) => componentProps.onAddMachine(event)}
        />
      )}
    </ModalDialog>
  );
}

function PairMachineForm(componentProps: PairMachineFormProps) {
  const hasPairingCode = createMemo(
    () => componentProps.pairingCodeExpiresInSeconds !== undefined,
  );
  return (
    <form
      {...styles.machineModalForm()}
      onSubmit={(event) => componentProps.onSubmit(event)}
    >
      <PairingRestartControl
        disabled={componentProps.isPairing}
        machineName={componentProps.selected.name}
        onRequestPairingCode={() => componentProps.onRequestPairingCode()}
      />
      {hasPairingCode() ? (
        <PairingCodeStep
          pairingCode={componentProps.pairingCode}
          pairingCodeExpiresInSeconds={
            componentProps.pairingCodeExpiresInSeconds
          }
          pairingCodeInputRef={componentProps.pairingCodeInputRef}
          onPairingCodeChange={(event) =>
            componentProps.onPairingCodeChange(event)
          }
        />
      ) : (
        <PairingConfirmationStep
          confirmationCode={componentProps.pairingConfirmationCode}
          isRequestingPairingCode={componentProps.isRequestingPairingCode}
        />
      )}
      <div {...styles.modalActions()}>
        <Button onClick={() => componentProps.onClose()}>Skip</Button>
        {hasPairingCode() ? (
          <Button
            type="submit"
            disabled={
              componentProps.isPairing ||
              componentProps.isRequestingPairingCode ||
              componentProps.pairingCode.length === 0
            }
          >
            {componentProps.isPairing ? (
              <Loader2 size={16} className={styles.loader2().class} />
            ) : (
              <KeyRound size={16} />
            )}
            Pair
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function PairingRestartControl(componentProps: PairingRestartControlProps) {
  return (
    <div {...styles.pairingControl()}>
      <span {...styles.span()}>
        <span {...styles.span2()}>Pairing to</span>
        <strong {...styles.strong()}>{componentProps.machineName}</strong>
      </span>
      <Button
        className={styles.button().class}
        disabled={componentProps.disabled}
        onClick={() => componentProps.onRequestPairingCode()}
        title="Restart pairing"
      >
        <RefreshCw size={16} />
        Restart pairing
      </Button>
    </div>
  );
}

function PairingConfirmationStep(componentProps: PairingConfirmationStepProps) {
  return (
    <section {...styles.pairingStep()}>
      <div {...styles.div()}>
        <span {...styles.span3()}>Confirmation code</span>
        <div {...styles.confirmationCode()}>
          {componentProps.confirmationCode ?? "--"}
        </div>
      </div>
      <p {...styles.p()}>
        Select this code on the daemon to reveal the pairing code.
      </p>
      {componentProps.isRequestingPairingCode ? (
        <div {...styles.div2()}>
          <Loader2 size={14} className={styles.loader2().class} />
          Waiting for confirmation
        </div>
      ) : null}
    </section>
  );
}

function PairingCodeStep(componentProps: PairingCodeStepProps) {
  return (
    <section {...styles.pairingStep()}>
      <label {...styles.label()}>
        <span>Pairing code</span>
        <input
          ref={(el) => {
            componentProps.pairingCodeInputRef.current = el;
          }}
          value={componentProps.pairingCode}
          onInput={(event) =>
            componentProps.onPairingCodeChange(
              event.target.value.replace(/\D/g, "").slice(0, 6),
            )
          }
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength={6}
          placeholder="000000"
          aria-label="Pairing code"
        />
      </label>
      {componentProps.pairingCodeExpiresInSeconds !== undefined ? (
        componentProps.pairingCodeExpiresInSeconds <= 0 ? (
          <p {...styles.p2()}>Pairing code expired. Restart pairing.</p>
        ) : (
          <p {...styles.p3()}>
            Pairing code expires in{" "}
            {formatRemainingTime(componentProps.pairingCodeExpiresInSeconds)}.
          </p>
        )
      ) : null}
    </section>
  );
}

function formatRemainingTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const minutesPart = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secondsPart = (seconds % 60).toString().padStart(2, "0");
  return `${minutesPart}:${secondsPart}`;
}

function MachineConfigForm(componentProps: MachineConfigFormProps) {
  return (
    <form
      {...styles.machineModalForm()}
      onSubmit={(event) => componentProps.onSubmit(event)}
    >
      <div {...styles.modalMachineSummary()}>
        <strong>{componentProps.selected.name}</strong>
        <span>{componentProps.selected.baseUrl}</span>
      </div>
      <label>
        <span>Name</span>
        <input
          ref={(el) => {
            componentProps.configNameInputRef.current = el;
          }}
          value={componentProps.configNameDraft}
          onInput={(event) =>
            componentProps.onConfigNameChange(event.target.value)
          }
          placeholder="Machine name"
          aria-label="Machine name"
        />
      </label>
      <label>
        <span>URL</span>
        <input
          value={componentProps.configUrlDraft}
          onInput={(event) =>
            componentProps.onConfigUrlChange(event.target.value)
          }
          placeholder="https://host:9012"
          aria-label="Machine URL"
        />
      </label>
      {componentProps.error ? (
        <div {...styles.fieldError()}>{componentProps.error}</div>
      ) : null}
      <div {...styles.modalActions()}>
        <Button onClick={() => componentProps.onClose()}>Cancel</Button>
        <Button type="submit">
          <Settings size={16} />
          Save
        </Button>
      </div>
    </form>
  );
}

function DeleteMachineForm(componentProps: DeleteMachineFormProps) {
  return (
    <div {...styles.machineModalForm()}>
      <div {...styles.modalMachineSummary()}>
        <strong>{componentProps.selected.name}</strong>
        <span>{componentProps.selected.baseUrl}</span>
      </div>
      <p {...styles.modalWarning()}>
        This removes the machine from this browser.
      </p>
      <div {...styles.modalActions()}>
        <Button onClick={() => componentProps.onClose()}>Cancel</Button>
        <Button
          className={styles.dangerAction().class}
          onClick={() => componentProps.onDelete()}
        >
          <Trash2 size={16} />
          Delete
        </Button>
      </div>
    </div>
  );
}

namespace styles {
  export const machineModalForm = style({
    selectors: {
      "& input": {
        font: "inherit",
        minHeight: "34px",
        minWidth: "0",
        borderWidth: "1px",
        borderColor: theme.borderMedium,
        borderRadius: theme.radiusMd,
        backgroundColor: theme.bgPrimary,
        paddingLeft: "10px",
        paddingRight: "10px",
        color: theme.textPrimary,
      },
      "& label": {
        display: "grid",
        minWidth: "0",
        gap: "0.5rem",
      },
      "& label span": {
        fontSize: "13px",
        color: theme.textSecondary,
        fontWeight: 600,
      },
      "& input:focus": {
        outlineWidth: "2px",
        outlineColor: theme.accent,
        outlineOffset: "1px",
        outlineStyle: "solid",
      },
    },
    display: "grid",
    gap: "0.5rem",
    padding: "16px",
  });
  export const modalMachineSummary = style({
    display: "grid",
    selectors: {
      "& span": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "13px",
        color: theme.textTertiary,
      },
      "& strong": {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "14px",
        color: theme.textPrimary,
      },
    },
    minWidth: "0",
    gap: "0.5rem",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusLg,
    backgroundColor: theme.bgSecondary,
    padding: "10px",
  });
  export const fieldError = style({
    fontSize: "13px",
    color: theme.danger,
  });
  export const modalActions = style({
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
  });
  export const modalWarning = style({
    margin: "0",
    fontSize: "13px",
    color: theme.textSecondary,
  });
  export const dangerAction = style({
    borderColor: theme.danger,
    selectors: {
      "&:hover": {
        borderColor: theme.danger,
        backgroundColor: theme.dangerSoft,
        color: theme.danger,
      },
    },
    backgroundColor: theme.dangerSoft,
    color: theme.danger,
  });
  export const pairingControl = style({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusLg,
    backgroundColor: theme.bgSecondary,
    paddingLeft: "10px",
    paddingRight: "10px",
    paddingTop: "8px",
    paddingBottom: "8px",
  });
  export const pairingStep = style({
    display: "grid",
    minHeight: "174px",
    placeItems: "center",
    gap: "0.5rem",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusLg,
    backgroundColor: theme.bgPrimary,
    paddingLeft: "16px",
    paddingRight: "16px",
    paddingTop: "18px",
    paddingBottom: "18px",
    textAlign: "center",
  });
  export const confirmationCode = style({
    display: "grid",
    height: "96px",
    minWidth: "156px",
    placeItems: "center",
    borderWidth: "1px",
    borderColor: theme.borderMedium,
    borderRadius: theme.radiusLg,
    backgroundColor: theme.bgSecondary,
    paddingLeft: "18px",
    paddingRight: "18px",
    fontSize: "56px",
    color: theme.textPrimary,
    fontWeight: 800,
    lineHeight: 1,
    letterSpacing: "0",
  });
  export const loader2 = style({
    animation: "spin 1s linear infinite",
  });
  export const span = style({
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "13px",
    color: theme.textSecondary,
  });
  export const span2 = style({
    flexShrink: 0,
  });
  export const strong = style({
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: theme.textPrimary,
    fontWeight: 700,
  });
  export const button = style({
    minWidth: "36px",
    paddingLeft: "10px",
    paddingRight: "10px",
  });
  export const div = style({
    display: "grid",
    justifyItems: "center",
    gap: "0.5rem",
  });
  export const span3 = style({
    fontSize: "13px",
    color: theme.textSecondary,
    fontWeight: 600,
  });
  export const p = style({
    margin: "0",
    maxWidth: "320px",
    fontSize: "14px",
    color: theme.textTertiary,
    lineHeight: 1.45,
  });
  export const div2 = style({
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "13px",
    color: theme.textSecondary,
  });

  export const label = style({
    width: "100%",
  });
  export const p2 = style({
    margin: "0",
    fontSize: "13px",
    color: theme.danger,
  });
  export const p3 = style({
    margin: "0",
    fontSize: "13px",
    color: theme.textTertiary,
  });
}
