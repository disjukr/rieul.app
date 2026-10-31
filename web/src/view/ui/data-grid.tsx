import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const dataGridVariants = cva(
  "grid min-h-0 min-w-0 overflow-auto bg-[var(--rieul-bg-primary)] leading-[1.6]",
  {
    variants: {
      density: {
        compact: "auto-rows-[2em]",
        regular: "auto-rows-[2rem]",
      },
    },
    defaultVariants: {
      density: "compact",
    },
  },
);

const dataGridHeaderCellVariants = cva(
  [
    "sticky top-0 z-[1] flex box-border items-center",
    "border-b border-b-[var(--rieul-border-light)] bg-[var(--rieul-bg-header)]",
    "font-700 text-[var(--rieul-text-tertiary)]",
  ],
  {
    variants: {
      density: {
        compact: "h-[2em] px-[8px]",
        regular: "h-[2rem] px-[8px]",
      },
    },
    defaultVariants: {
      density: "compact",
    },
  },
);

const dataGridRowVariants = cva(
  [
    "grid [grid-column:1/-1] [grid-template-columns:subgrid]",
    "box-border rounded-0 border-0 border-b border-b-[var(--rieul-bg-muted)]",
    "bg-[var(--rieul-bg-primary)] text-left leading-[1.6]",
  ],
  {
    variants: {
      density: {
        compact: "h-[2em] min-h-[2em]",
        regular: "h-[2rem] min-h-[2rem]",
      },
      interactive: {
        false: "",
        true: "appearance-none cursor-pointer p-0 [font-family:inherit] hover:bg-[var(--rieul-bg-hover-weak)]",
      },
      selected: {
        false: "",
        true: "bg-[var(--rieul-bg-selected)]",
      },
    },
    defaultVariants: {
      density: "compact",
      interactive: false,
      selected: false,
    },
  },
);

const dataGridCellVariants = cva(
  "flex min-w-0 items-center overflow-hidden px-[8px] text-ellipsis whitespace-nowrap",
  {
    variants: {
      tone: {
        primary: "text-[var(--rieul-text-strong)]",
        secondary: "text-[var(--rieul-text-tertiary)]",
      },
    },
    defaultVariants: {
      tone: "primary",
    },
  },
);

export interface DataGridProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof dataGridVariants> {
  className?: string;
}

export interface DataGridHeaderCellProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof dataGridHeaderCellVariants> {
  className?: string;
}

export interface DataGridRowProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof dataGridRowVariants> {
  className?: string;
}

export interface DataGridCellProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof dataGridCellVariants> {
  className?: string;
}

export function DataGrid(componentProps: DataGridProps) {
  const otherProps = omit(componentProps, "className", "density");

  return (
    <div
      {...otherProps}
      class={joinClassName(
        dataGridVariants({ density: componentProps.density }),
        componentProps.className,
      )}
    />
  );
}

export function DataGridHeaderCell(componentProps: DataGridHeaderCellProps) {
  const otherProps = omit(componentProps, "className", "density");

  return (
    <div
      {...otherProps}
      class={joinClassName(
        dataGridHeaderCellVariants({ density: componentProps.density }),
        componentProps.className,
      )}
    />
  );
}

export function DataGridRow(componentProps: DataGridRowProps) {
  const otherProps = omit(
    componentProps,
    "className",
    "density",
    "interactive",
    "selected",
  );

  return (
    <div
      {...otherProps}
      class={joinClassName(
        dataGridRowVariants({
          density: componentProps.density,
          interactive: componentProps.interactive,
          selected: componentProps.selected,
        }),
        componentProps.className,
      )}
    />
  );
}

export function DataGridCell(componentProps: DataGridCellProps) {
  const otherProps = omit(componentProps, "className", "tone");

  return (
    <div
      {...otherProps}
      class={joinClassName(
        dataGridCellVariants({ tone: componentProps.tone }),
        componentProps.className,
      )}
    />
  );
}
