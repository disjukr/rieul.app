import React, { FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "../ui/button.tsx";

const machineModalFormClassName = [
  "grid gap-[12px] p-[16px]",
  "[&_label]:grid [&_label]:gap-[6px] [&_label]:min-w-0",
  "[&_label_span]:text-[#475467] [&_label_span]:text-[12px] [&_label_span]:font-700",
  "[&_input]:min-w-0 [&_input]:min-h-[34px] [&_input]:border [&_input]:border-[#c7ceda]",
  "[&_input]:rounded-[6px] [&_input]:bg-white [&_input]:px-[10px] [&_input]:text-[#20242d]",
  "[&_input]:[font:inherit] [&_input:focus]:outline [&_input:focus]:outline-2",
  "[&_input:focus]:outline-[#4f8cff] [&_input:focus]:outline-offset-1",
].join(" ");
const fieldErrorClassName = "text-[#b42318] text-[12px]";
const modalActionsClassName = "flex justify-end gap-[8px]";

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
          placeholder="https://host:9012"
          aria-label="Machine URL"
        />
      </label>
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
