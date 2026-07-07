import React, { FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/field.tsx";

const machineModalFormClassName = "grid gap-[0.5rem] p-[16px]";
const fieldErrorClassName = "text-[var(--wgo-danger)] text-[1rem]";
const modalActionsClassName = "flex justify-end gap-[0.5rem]";

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
    <form className={machineModalFormClassName} onSubmit={onSubmit}>
      <TextField
        ref={machineNameInputRef}
        label="Name"
        value={machineName}
        onChange={(event) => onMachineNameChange(event.target.value)}
        placeholder="Local daemon"
        aria-label="Machine name"
      />
      <TextField
        label="URL"
        value={baseUrl}
        onChange={(event) => onBaseUrlChange(event.target.value)}
        placeholder="https://host:9012"
        aria-label="Machine URL"
      />
      {error ? <div className={fieldErrorClassName}>{error}</div> : null}
      <div className={modalActionsClassName}>
        {showCancel
          ? (
            <Button onClick={onCancel}>
              Cancel
            </Button>
          )
          : null}
        <Button type="submit">
          <Plus size={16} />
          Continue
        </Button>
      </div>
    </form>
  );
}
