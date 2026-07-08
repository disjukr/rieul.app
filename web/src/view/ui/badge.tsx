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
        solid: "text-[var(--rieul-text-inverse)]",
      },
    },
    compoundVariants: [
      {
        tone: "neutral",
        variant: "soft",
        className:
          "border-[var(--rieul-border-light)] bg-[var(--rieul-bg-control-disabled)] text-[var(--rieul-text-control)]",
      },
      {
        tone: "neutral",
        variant: "outline",
        className:
          "border-[var(--rieul-border-light)] text-[var(--rieul-text-secondary)]",
      },
      {
        tone: "neutral",
        variant: "solid",
        className:
          "border-[var(--rieul-text-control)] bg-[var(--rieul-text-control)]",
      },
      {
        tone: "accent",
        variant: "soft",
        className:
          "border-[var(--rieul-accent-soft-strong)] bg-[var(--rieul-accent-soft-strong)] text-[var(--rieul-accent)]",
      },
      {
        tone: "accent",
        variant: "outline",
        className: "border-[var(--rieul-accent)] text-[var(--rieul-accent)]",
      },
      {
        tone: "accent",
        variant: "solid",
        className: "border-[var(--rieul-accent)] bg-[var(--rieul-accent)]",
      },
      {
        tone: "danger",
        variant: "soft",
        className:
          "border-[var(--rieul-danger-soft-muted)] bg-[var(--rieul-danger-soft-muted)] text-[var(--rieul-danger)]",
      },
      {
        tone: "danger",
        variant: "outline",
        className: "border-[var(--rieul-danger-border)] text-[var(--rieul-danger)]",
      },
      {
        tone: "danger",
        variant: "solid",
        className: "border-[var(--rieul-danger)] bg-[var(--rieul-danger)]",
      },
      {
        tone: "success",
        variant: "soft",
        className:
          "border-[var(--rieul-success-soft)] bg-[var(--rieul-success-soft)] text-[var(--rieul-success)]",
      },
      {
        tone: "success",
        variant: "outline",
        className: "border-[var(--rieul-success)] text-[var(--rieul-success)]",
      },
      {
        tone: "success",
        variant: "solid",
        className: "border-[var(--rieul-success)] bg-[var(--rieul-success)]",
      },
      {
        tone: "warning",
        variant: "soft",
        className:
          "border-[var(--rieul-border-warning)] bg-[var(--rieul-warning-soft)] text-[var(--rieul-warning)]",
      },
      {
        tone: "warning",
        variant: "outline",
        className:
          "border-[var(--rieul-border-warning)] text-[var(--rieul-warning)]",
      },
      {
        tone: "warning",
        variant: "solid",
        className: "border-[var(--rieul-warning)] bg-[var(--rieul-warning)]",
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
