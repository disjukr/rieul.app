import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const badgeVariants = cva(
  [
    "inline-flex max-w-full items-center gap-[4px] rounded-full border",
    "font-750 leading-[1] whitespace-nowrap",
  ],
  {
    variants: {
      size: {
        md: "px-[0.5rem] py-[2px] text-[1rem]",
        sm: "px-[4px] py-0 text-[11px]",
      },
      tone: {
        accent: "",
        danger: "",
        neutral: "",
        success: "",
        warning: "",
      },
      variant: {
        outline: "bg-transparent",
        soft: "",
        solid: "text-[var(--wgo-text-inverse)]",
      },
    },
    compoundVariants: [
      {
        tone: "neutral",
        variant: "soft",
        className:
          "border-[var(--wgo-border-light)] bg-[var(--wgo-bg-control-disabled)] text-[var(--wgo-text-control)]",
      },
      {
        tone: "neutral",
        variant: "outline",
        className:
          "border-[var(--wgo-border-light)] text-[var(--wgo-text-secondary)]",
      },
      {
        tone: "neutral",
        variant: "solid",
        className:
          "border-[var(--wgo-text-control)] bg-[var(--wgo-text-control)]",
      },
      {
        tone: "accent",
        variant: "soft",
        className:
          "border-[var(--wgo-accent-soft-strong)] bg-[var(--wgo-accent-soft-strong)] text-[var(--wgo-accent)]",
      },
      {
        tone: "accent",
        variant: "outline",
        className: "border-[var(--wgo-accent)] text-[var(--wgo-accent)]",
      },
      {
        tone: "accent",
        variant: "solid",
        className: "border-[var(--wgo-accent)] bg-[var(--wgo-accent)]",
      },
      {
        tone: "danger",
        variant: "soft",
        className:
          "border-[var(--wgo-danger-soft-muted)] bg-[var(--wgo-danger-soft-muted)] text-[var(--wgo-danger)]",
      },
      {
        tone: "danger",
        variant: "outline",
        className: "border-[var(--wgo-danger-border)] text-[var(--wgo-danger)]",
      },
      {
        tone: "danger",
        variant: "solid",
        className: "border-[var(--wgo-danger)] bg-[var(--wgo-danger)]",
      },
      {
        tone: "success",
        variant: "soft",
        className:
          "border-[var(--wgo-success-soft)] bg-[var(--wgo-success-soft)] text-[var(--wgo-success)]",
      },
      {
        tone: "success",
        variant: "outline",
        className: "border-[var(--wgo-success)] text-[var(--wgo-success)]",
      },
      {
        tone: "success",
        variant: "solid",
        className: "border-[var(--wgo-success)] bg-[var(--wgo-success)]",
      },
      {
        tone: "warning",
        variant: "soft",
        className:
          "border-[var(--wgo-border-warning)] bg-[var(--wgo-warning-soft)] text-[var(--wgo-warning)]",
      },
      {
        tone: "warning",
        variant: "outline",
        className:
          "border-[var(--wgo-border-warning)] text-[var(--wgo-warning)]",
      },
      {
        tone: "warning",
        variant: "solid",
        className: "border-[var(--wgo-warning)] bg-[var(--wgo-warning)]",
      },
    ],
    defaultVariants: {
      size: "md",
      tone: "neutral",
      variant: "soft",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
}

export function Badge(
  { className, size, tone, variant, ...props }: BadgeProps,
) {
  return (
    <span
      {...props}
      className={joinClassName(
        badgeVariants({ size, tone, variant }),
        className,
      )}
    />
  );
}
