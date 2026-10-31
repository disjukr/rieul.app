import type { JSX } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";
import { className as joinClassName } from "../class-name.ts";

const fieldRootVariants = cva("grid min-w-0 gap-[0.5rem]");
const labelVariants = cva(
  "text-[1rem] font-700 text-[var(--rieul-text-secondary)]",
);
const inputVariants = cva([
  "min-h-[34px] min-w-0 rounded-[var(--rieul-radius-md)]",
  "border border-[var(--rieul-border-control)] bg-[var(--rieul-bg-primary)] px-[1rem]",
  "text-[var(--rieul-text-primary)] [font:inherit]",
  "focus:outline focus:outline-2 focus:outline-[var(--rieul-focus)]",
  "focus:outline-offset-1",
  "disabled:cursor-not-allowed disabled:opacity-48",
]);
const errorVariants = cva("text-[1rem] text-[var(--rieul-danger)]");

export interface TextFieldProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "className">,
    VariantProps<typeof inputVariants> {
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
    <label class={joinClassName(fieldRootVariants(), componentProps.className)}>
      <span class={labelVariants()}>{componentProps.label}</span>
      <input
        {...otherProps}
        class={joinClassName(inputVariants(), componentProps.inputClassName)}
      />
      {componentProps.error ? (
        <span role="alert" class={errorVariants()}>
          {componentProps.error}
        </span>
      ) : null}
    </label>
  );
}
