import { style, theme } from "../../zyzz.config.ts";
import { Plus } from "../../solid/icons.tsx";
import { Button } from "../ui/button.tsx";

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
      {...styles.machineModalForm()}
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
        <div {...styles.fieldError()}>{componentProps.error}</div>
      ) : null}
      <div {...styles.modalActions()}>
        {componentProps.showCancel ? (
          <Button onClick={() => componentProps.onCancel()}>Cancel</Button>
        ) : null}
        <Button type="submit" className={styles.button().class}>
          <Plus size={16} />
          Continue
        </Button>
      </div>
    </form>
  );
}

namespace styles {
  export const machineModalForm = style({
    selectors: {
      "& input": {
        font: "inherit",
        minHeight: "40px",
        minWidth: "0",
        borderWidth: "1px",
        borderColor: theme.borderMedium,
        borderRadius: theme.radiusLg,
        backgroundColor: theme.bgSecondary,
        paddingLeft: "12px",
        paddingRight: "12px",
        color: theme.textPrimary,
        boxShadow:
          "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 0 1px 0 rgba(255, 255, 255, 0.75)",
      },
      "& label": {
        display: "grid",
        minWidth: "0",
        gap: "7px",
      },
      "& input:focus": {
        backgroundColor: theme.bgPrimary,
        outlineWidth: "2px",
        outlineColor: theme.accent,
        outlineOffset: "1px",
        outlineStyle: "solid",
      },
      "& label span": {
        fontSize: "13px",
        color: theme.textSecondary,
        fontWeight: 700,
      },
    },
    display: "grid",
    gap: "12px",
    padding: "18px",
  });
  export const fieldError = style({
    borderRadius: theme.radiusLg,
    backgroundColor: theme.dangerSoft,
    paddingLeft: "10px",
    paddingRight: "10px",
    paddingTop: "8px",
    paddingBottom: "8px",
    fontSize: "13px",
    color: theme.danger,
  });
  export const modalActions = style({
    marginTop: "4px",
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
  });
  export const button = style({
    borderColor: theme.chrome,
    selectors: {
      "&:hover": {
        borderColor: theme.chrome,
        backgroundColor: theme.chromeMuted,
        color: "var(--rieul-text-inverse) !important",
      },
    },
    backgroundColor: theme.chrome,
    paddingLeft: "12px",
    paddingRight: "12px",
    color: "var(--rieul-text-inverse) !important",
  });
}
