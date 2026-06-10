import React, { FormEvent } from "react";
import { Plus } from "lucide-react";

interface AddMachineFormProps {
  baseUrl: string;
  error: string;
  machineName: string;
  machineNameInputRef: React.RefObject<HTMLInputElement | null>;
  showCancel: boolean;
  onBaseUrlChange: (value: string) => void;
  onCancel: () => void;
  onMachineNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function AddMachineForm(
  {
    baseUrl,
    error,
    machineName,
    machineNameInputRef,
    showCancel,
    onBaseUrlChange,
    onCancel,
    onMachineNameChange,
    onSubmit,
  }: AddMachineFormProps,
) {
  return (
    <form className="machine-modal-form" onSubmit={onSubmit}>
      <label>
        <span>Name</span>
        <input
          ref={machineNameInputRef}
          value={machineName}
          onChange={(event) => onMachineNameChange(event.target.value)}
          placeholder="Local daemon"
          aria-label="Machine name"
        />
      </label>
      <label>
        <span>URL</span>
        <input
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          placeholder="https://host:8765"
          aria-label="Machine URL"
        />
      </label>
      {error ? <div className="field-error">{error}</div> : null}
      <div className="modal-actions">
        {showCancel
          ? (
            <button type="button" onClick={onCancel}>
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
