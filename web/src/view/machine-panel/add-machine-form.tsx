import { Plus } from "../../solid/icons.tsx";
import { Button } from "../ui/button.tsx";

const machineModalFormClassName = [
  "grid gap-[12px] p-[18px]",
  "[&_label]:grid [&_label]:gap-[7px] [&_label]:min-w-0",
  "[&_label_span]:text-rieul-text-2 [&_label_span]:text-[13px] [&_label_span]:font-700",
  "[&_input]:min-w-0 [&_input]:min-h-[40px] [&_input]:border [&_input]:border-rieul-border-medium",
  "[&_input]:rounded-rieul-lg [&_input]:bg-rieul-surface-2 [&_input]:px-[12px] [&_input]:text-rieul-text",
  "[&_input]:shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]",
  "[&_input]:[font:inherit] [&_input:focus]:outline [&_input:focus]:outline-2",
  "[&_input:focus]:bg-rieul-surface [&_input:focus]:outline-rieul-accent [&_input:focus]:outline-offset-1",
].join(" ");
const fieldErrorClassName =
  "rounded-rieul-lg bg-rieul-danger-soft px-[10px] py-[8px] text-rieul-danger text-[13px]";
const modalActionsClassName = "mt-[4px] flex justify-end gap-[0.5rem]";

interface AddMachineFormProps {
  baseUrl: string;
  error: string;
  machineName: string;
  machineNameInputRef: { current: HTMLInputElement | null };
  showCancel: boolean;
  onBaseUrlChange: (value: string) => void;
  onCancel: () => void;
  onMachineNameChange: (value: string) => void;
  onSubmit: (event: SubmitEvent & { currentTarget: HTMLFormElement }) => void;
}

export function AddMachineForm(componentProps: AddMachineFormProps) {
  return (
    <form
      class={machineModalFormClassName}
      onSubmit={(event) => componentProps.onSubmit(event)}
    >
      <label>
        <span>Name</span>
        <input
          ref={(el) => {
            componentProps.machineNameInputRef.current = el;
          }}
          value={componentProps.machineName}
          onInput={(event) =>
            componentProps.onMachineNameChange(event.target.value)
          }
          placeholder="Local daemon"
          aria-label="Machine name"
        />
      </label>
      <label>
        <span>URL</span>
        <input
          value={componentProps.baseUrl}
          onInput={(event) =>
            componentProps.onBaseUrlChange(event.target.value)
          }
          placeholder="https://host:9012"
          aria-label="Machine URL"
        />
      </label>
      {componentProps.error ? (
        <div class={fieldErrorClassName}>{componentProps.error}</div>
      ) : null}
      <div class={modalActionsClassName}>
        {componentProps.showCancel ? (
          <Button onClick={() => componentProps.onCancel()}>Cancel</Button>
        ) : null}
        <Button
          type="submit"
          className="border-rieul-chrome bg-rieul-chrome px-[12px] !text-rieul-inverse hover:border-rieul-chrome hover:bg-rieul-chrome-muted hover:!text-rieul-inverse"
        >
          <Plus size={16} />
          Continue
        </Button>
      </div>
    </form>
  );
}
