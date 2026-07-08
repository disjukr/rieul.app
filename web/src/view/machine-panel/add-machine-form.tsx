import React, { FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "../ui/button.tsx";

const machineModalFormClassName = [
  "grid gap-[12px] p-[18px]",
  "[&_label]:grid [&_label]:gap-[7px] [&_label]:min-w-0",
  "[&_label_span]:text-wgo-text-2 [&_label_span]:text-[13px] [&_label_span]:font-700",
  "[&_input]:min-w-0 [&_input]:min-h-[40px] [&_input]:border [&_input]:border-wgo-border-medium",
  "[&_input]:rounded-wgo-lg [&_input]:bg-wgo-surface-2 [&_input]:px-[12px] [&_input]:text-wgo-text",
  "[&_input]:shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]",
  "[&_input]:[font:inherit] [&_input:focus]:outline [&_input:focus]:outline-2",
  "[&_input:focus]:bg-wgo-surface [&_input:focus]:outline-wgo-accent [&_input:focus]:outline-offset-1",
].join(" ");
const fieldErrorClassName =
  "rounded-wgo-lg bg-wgo-danger-soft px-[10px] py-[8px] text-wgo-danger text-[13px]";
const modalActionsClassName = "mt-[4px] flex justify-end gap-[0.5rem]";

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
        <Button
          type="submit"
          className="border-wgo-chrome bg-wgo-chrome px-[12px] !text-wgo-inverse hover:border-wgo-chrome hover:bg-wgo-chrome-muted hover:!text-wgo-inverse"
        >
          <Plus size={16} />
          Continue
        </Button>
      </div>
    </form>
  );
}
