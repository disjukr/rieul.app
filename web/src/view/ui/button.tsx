import { Button as BaseButton } from "@base-ui/react/button";
import type React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const buttonVariants = cva(
  [
    "inline-flex appearance-none items-center justify-center gap-[7px]",
    "border [font:inherit] cursor-pointer",
    "focus-visible:outline focus-visible:outline-2",
    "focus-visible:outline-[var(--wgo-focus)] focus-visible:outline-offset-1",
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
        outline: "bg-[var(--wgo-bg-primary)]",
        soft: "",
        solid: "",
      },
      size: {
        icon: "h-[34px] min-h-[34px] w-[34px] min-w-[34px] p-0",
        md: "min-h-[34px] rounded-[var(--wgo-radius-md)] px-[10px]",
        sm: "min-h-[28px] rounded-[var(--wgo-radius-sm)] px-[8px]",
      },
    },
    compoundVariants: [
      {
        tone: "neutral",
        variant: "solid",
        className:
          "border-[var(--wgo-border-medium)] bg-[var(--wgo-bg-primary)] text-[var(--wgo-text-primary)] hover:border-[var(--wgo-border-action-hover)] hover:bg-[var(--wgo-bg-hover-weak)]",
      },
      {
        tone: "neutral",
        variant: "outline",
        className:
          "border-[var(--wgo-border-medium)] text-[var(--wgo-text-primary)] hover:border-[var(--wgo-border-action-hover)] hover:bg-[var(--wgo-bg-hover-weak)]",
      },
      {
        tone: "neutral",
        variant: "soft",
        className:
          "border-[var(--wgo-border-light)] bg-[var(--wgo-bg-secondary)] text-[var(--wgo-text-primary)] hover:bg-[var(--wgo-bg-hover)]",
      },
      {
        tone: "neutral",
        variant: "ghost",
        className:
          "text-[var(--wgo-text-primary)] hover:border-[var(--wgo-border-light)] hover:bg-[var(--wgo-bg-secondary)]",
      },
      {
        tone: "danger",
        variant: "solid",
        className:
          "border-[var(--wgo-danger)] bg-[var(--wgo-danger)] text-[var(--wgo-text-inverse)] hover:border-[var(--wgo-danger-hover)] hover:bg-[var(--wgo-danger-hover)]",
      },
      {
        tone: "danger",
        variant: "outline",
        className:
          "border-[var(--wgo-danger-border)] text-[var(--wgo-danger)] hover:border-[var(--wgo-danger-border-hover)] hover:bg-[var(--wgo-danger-soft-hover)] hover:text-[var(--wgo-danger-hover)]",
      },
      {
        tone: "danger",
        variant: "soft",
        className:
          "border-[var(--wgo-danger-border)] bg-[var(--wgo-danger-soft)] text-[var(--wgo-danger)] hover:border-[var(--wgo-danger-border-hover)] hover:bg-[var(--wgo-danger-soft-hover)] hover:text-[var(--wgo-danger-hover)]",
      },
      {
        tone: "danger",
        variant: "ghost",
        className:
          "text-[var(--wgo-danger)] hover:border-[var(--wgo-danger-border)] hover:bg-[var(--wgo-danger-soft-hover)] hover:text-[var(--wgo-danger-hover)]",
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
