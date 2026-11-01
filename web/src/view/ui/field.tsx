import { className as joinClassName } from "../class-name.ts";
import { variants, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import type { Props } from "zyzz";
import { omit } from "solid-js";

const fieldRootVariants = variants({
  base: {
    display: "grid",
    minWidth: "0",
    gap: "0.5rem",
  },
});
const labelVariants = variants({
  base: {
    fontSize: "1rem",
    color: theme.textSecondary,
    fontWeight: 700,
  },
});
const inputVariants = variants({
  base: {
    font: "inherit",
    minHeight: "34px",
    minWidth: "0",
    selectors: {
      "&:disabled": {
        cursor: "not-allowed",
        opacity: 0.48,
      },
      "&:focus": {
        outlineWidth: "2px",
        outlineColor: theme.focus,
        outlineOffset: "1px",
        outlineStyle: "solid",
      },
    },
    borderWidth: "1px",
    borderColor: theme.borderControl,
    borderRadius: theme.radiusMd,
    backgroundColor: theme.bgPrimary,
    paddingLeft: "1rem",
    paddingRight: "1rem",
    color: theme.textPrimary,
  },
});
const errorVariants = variants({
  base: {
    fontSize: "1rem",
    color: theme.danger,
  },
});

export interface TextFieldProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "className">,
    Omit<Props.Variants<typeof inputVariants>, "className" | "style" | "vars"> {
  className?: string;
  error?: string;
  inputClassName?: string;
  label: string;
  ref?: (element: HTMLInputElement) => void;
}

export function TextField(componentProps: TextFieldProps) {
  const otherProps = omit(
    componentProps,
    "className",
    "error",
    "inputClassName",
    "label",
  );

  return (
    <label
      {...fieldRootVariants({
        className: joinClassName(componentProps.className ?? ""),
      })}
    >
      <span {...labelVariants()}>{componentProps.label}</span>
      <input
        {...otherProps}
        {...inputVariants({
          className: joinClassName(componentProps.inputClassName ?? ""),
        })}
      />
      {componentProps.error ? (
        <span role="alert" {...errorVariants()}>
          {componentProps.error}
        </span>
      ) : null}
    </label>
  );
}
