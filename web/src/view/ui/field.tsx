import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import type React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const fieldRootVariants = cva("grid min-w-0 gap-[0.5rem]");
const labelVariants = cva(
  "text-[1rem] font-700 text-[var(--wgo-text-secondary)]",
);
const inputVariants = cva(
  [
    "min-h-[34px] min-w-0 rounded-[var(--wgo-radius-md)]",
    "border border-[var(--wgo-border-control)] bg-[var(--wgo-bg-primary)] px-[1rem]",
    "text-[var(--wgo-text-primary)] [font:inherit]",
    "focus:outline focus:outline-2 focus:outline-[var(--wgo-focus)]",
    "focus:outline-offset-1",
    "disabled:cursor-not-allowed disabled:opacity-48",
  ],
);
const errorVariants = cva("text-[1rem] text-[var(--wgo-danger)]");

export interface TextFieldProps
  extends
    Omit<React.ComponentPropsWithoutRef<typeof Input>, "className">,
    VariantProps<typeof inputVariants> {
  className?: string;
  error?: string;
  inputClassName?: string;
  label: string;
  ref?: React.Ref<HTMLInputElement>;
}

export function TextField(
  {
    className,
    error,
    inputClassName,
    label,
    ...props
  }: TextFieldProps,
) {
  return (
    <Field.Root className={joinClassName(fieldRootVariants(), className)}>
      <Field.Label className={labelVariants()}>{label}</Field.Label>
      <Input
        {...props}
        className={joinClassName(inputVariants(), inputClassName)}
      />
      {error
        ? <Field.Error className={errorVariants()}>{error}</Field.Error>
        : null}
    </Field.Root>
  );
}
