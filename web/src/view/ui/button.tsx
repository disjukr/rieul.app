import { Button as BaseButton } from "@base-ui/react/button";
import type React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const buttonVariants = cva(
  [
    "inline-flex appearance-none items-center justify-center gap-[7px]",
    "border [font:inherit] cursor-pointer",
    "focus-visible:outline focus-visible:outline-2",
    "focus-visible:outline-[var(--rieul-focus)] focus-visible:outline-offset-1",
    "disabled:cursor-not-allowed disabled:opacity-48",
    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-48",
  ],
  {
    variants: {
      tone: {
        danger: "",
        neutral: "",
      },
      variant: {
        ghost: "border-transparent bg-transparent",
        outline: "bg-[var(--rieul-bg-primary)]",
        soft: "",
        solid: "",
      },
      size: {
        icon: "h-[34px] min-h-[34px] w-[34px] min-w-[34px] p-0",
        md: "min-h-[34px] rounded-[var(--rieul-radius-md)] px-[10px]",
        sm: "min-h-[28px] rounded-[var(--rieul-radius-sm)] px-[8px]",
      },
    },
    compoundVariants: [
      {
        tone: "neutral",
        variant: "solid",
        className:
          "border-[var(--rieul-border-medium)] bg-[var(--rieul-bg-primary)] text-[var(--rieul-text-primary)] hover:border-[var(--rieul-border-action-hover)] hover:bg-[var(--rieul-bg-hover-weak)]",
      },
      {
        tone: "neutral",
        variant: "outline",
        className:
          "border-[var(--rieul-border-medium)] text-[var(--rieul-text-primary)] hover:border-[var(--rieul-border-action-hover)] hover:bg-[var(--rieul-bg-hover-weak)]",
      },
      {
        tone: "neutral",
        variant: "soft",
        className:
          "border-[var(--rieul-border-light)] bg-[var(--rieul-bg-secondary)] text-[var(--rieul-text-primary)] hover:bg-[var(--rieul-bg-hover)]",
      },
      {
        tone: "neutral",
        variant: "ghost",
        className:
          "text-[var(--rieul-text-primary)] hover:border-[var(--rieul-border-light)] hover:bg-[var(--rieul-bg-secondary)]",
      },
      {
        tone: "danger",
        variant: "solid",
        className:
          "border-[var(--rieul-danger)] bg-[var(--rieul-danger)] text-[var(--rieul-text-inverse)] hover:border-[var(--rieul-danger-hover)] hover:bg-[var(--rieul-danger-hover)]",
      },
      {
        tone: "danger",
        variant: "outline",
        className:
          "border-[var(--rieul-danger-border)] text-[var(--rieul-danger)] hover:border-[var(--rieul-danger-border-hover)] hover:bg-[var(--rieul-danger-soft-hover)] hover:text-[var(--rieul-danger-hover)]",
      },
      {
        tone: "danger",
        variant: "soft",
        className:
          "border-[var(--rieul-danger-border)] bg-[var(--rieul-danger-soft)] text-[var(--rieul-danger)] hover:border-[var(--rieul-danger-border-hover)] hover:bg-[var(--rieul-danger-soft-hover)] hover:text-[var(--rieul-danger-hover)]",
      },
      {
        tone: "danger",
        variant: "ghost",
        className:
          "text-[var(--rieul-danger)] hover:border-[var(--rieul-danger-border)] hover:bg-[var(--rieul-danger-soft-hover)] hover:text-[var(--rieul-danger-hover)]",
      },
    ],
    defaultVariants: {
      size: "md",
      tone: "neutral",
      variant: "solid",
    },
  },
);

export interface ButtonProps
  extends
    Omit<React.ComponentPropsWithoutRef<typeof BaseButton>, "className">,
    VariantProps<typeof buttonVariants> {
  className?: string;
}

export function Button(
  { className, size, tone, type = "button", variant, ...props }: ButtonProps,
) {
  return (
    <BaseButton
      {...props}
      type={type}
      className={joinClassName(
        buttonVariants({ size, tone, variant }),
        className,
      )}
    />
  );
}
