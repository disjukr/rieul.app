import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const surfaceVariants = cva("min-w-0", {
  variants: {
    border: {
      none: "",
      subtle: "border border-[var(--rieul-border-light)]",
    },
    radius: {
      none: "rounded-0",
      md: "rounded-[var(--rieul-radius-md)]",
      lg: "rounded-[var(--rieul-radius-lg)]",
    },
    variant: {
      canvas: "bg-[var(--rieul-bg-canvas)]",
      header: "bg-[var(--rieul-bg-header)]",
      primary: "bg-[var(--rieul-bg-primary)]",
      secondary: "bg-[var(--rieul-bg-secondary)]",
      subtle: "bg-[var(--rieul-bg-subtle)]",
    },
  },
  defaultVariants: {
    border: "none",
    radius: "none",
    variant: "primary",
  },
});

const surfaceHeaderVariants = cva(
  "flex min-w-0 items-center border-b border-b-[var(--rieul-border-light)] bg-[var(--rieul-bg-header)]",
  {
    variants: {
      density: {
        compact: "min-h-[2rem] px-[8px]",
        regular: "min-h-[48px] px-[1rem]",
      },
    },
    defaultVariants: {
      density: "compact",
    },
  },
);

export interface SurfaceProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof surfaceVariants> {
}

export interface SurfaceHeaderProps
  extends
    HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surfaceHeaderVariants> {
}

export function Surface(
  { border, className, radius, variant, ...props }: SurfaceProps,
) {
  return (
    <div
      {...props}
      className={joinClassName(
        surfaceVariants({ border, radius, variant }),
        className,
      )}
    />
  );
}

export function SurfaceHeader(
  { className, density, ...props }: SurfaceHeaderProps,
) {
  return (
    <div
      {...props}
      className={joinClassName(surfaceHeaderVariants({ density }), className)}
    />
  );
}
