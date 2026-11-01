import { className as joinClassName } from "../class-name.ts";
import { variants, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import type { Props } from "zyzz";

const dataGridVariants = variants({
  base: {
    display: "grid",
    minHeight: "0",
    minWidth: "0",
    overflow: "auto",
    backgroundColor: theme.bgPrimary,
    lineHeight: 1.6,
  },
  variants: {
    density: {
      compact: {
        gridAutoRows: "2em",
      },
      regular: {
        gridAutoRows: "2rem",
      },
    },
  },
  defaultVariants: {
    density: "compact",
  },
});

const dataGridHeaderCellVariants = variants({
  base: {
    position: "sticky",
    top: "0",
    zIndex: 1,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderLight,
    backgroundColor: theme.bgHeader,
    color: theme.textTertiary,
    fontWeight: 700,
  },
  variants: {
    density: {
      compact: {
        height: "2em",
        paddingLeft: "8px",
        paddingRight: "8px",
      },
      regular: {
        height: "2rem",
        paddingLeft: "8px",
        paddingRight: "8px",
      },
    },
  },
  defaultVariants: {
    density: "compact",
  },
});

const dataGridRowVariants = variants({
  base: {
    gridColumn: "1/-1",
    gridTemplateColumns: "subgrid",
    display: "grid",
    boxSizing: "border-box",
    borderWidth: "0px",
    borderBottomWidth: "1px",
    borderBottomColor: theme.bgMuted,
    borderRadius: "0",
    backgroundColor: theme.bgPrimary,
    textAlign: "left",
    lineHeight: 1.6,
  },
  variants: {
    density: {
      compact: {
        height: "2em",
        minHeight: "2em",
      },
      regular: {
        height: "2rem",
        minHeight: "2rem",
      },
    },
    interactive: {
      false: {},
      true: {
        fontFamily: "inherit",
        cursor: "pointer",
        WebkitAppearance: "none",
        appearance: "none",
        selectors: {
          "&:hover": {
            backgroundColor: theme.bgHoverWeak,
          },
        },
        padding: "0",
      },
    },
    selected: {
      false: {},
      true: {
        backgroundColor: theme.bgSelected,
      },
    },
  },
  defaultVariants: {
    density: "compact",
    interactive: false,
    selected: false,
  },
});

const dataGridCellVariants = variants({
  base: {
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingLeft: "8px",
    paddingRight: "8px",
  },
  variants: {
    tone: {
      primary: {
        color: theme.textStrong,
      },
      secondary: {
        color: theme.textTertiary,
      },
    },
  },
  defaultVariants: {
    tone: "primary",
  },
});

export interface DataGridProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    Omit<
      Props.Variants<typeof dataGridVariants>,
      "className" | "style" | "vars"
    > {
  className?: string;
}

export interface DataGridHeaderCellProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    Omit<
      Props.Variants<typeof dataGridHeaderCellVariants>,
      "className" | "style" | "vars"
    > {
  className?: string;
}

export interface DataGridRowProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    Omit<
      Props.Variants<typeof dataGridRowVariants>,
      "className" | "style" | "vars"
    > {
  className?: string;
}

export interface DataGridCellProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    Omit<
      Props.Variants<typeof dataGridCellVariants>,
      "className" | "style" | "vars"
    > {
  className?: string;
}

export function DataGrid(componentProps: DataGridProps) {
  const otherProps = omit(componentProps, "className", "density");

  return (
    <div
      {...otherProps}
      {...dataGridVariants({
        density: componentProps.density,
        className: joinClassName(componentProps.className ?? ""),
      })}
    />
  );
}

export function DataGridHeaderCell(componentProps: DataGridHeaderCellProps) {
  const otherProps = omit(componentProps, "className", "density");

  return (
    <div
      {...otherProps}
      {...dataGridHeaderCellVariants({
        density: componentProps.density,
        className: joinClassName(componentProps.className ?? ""),
      })}
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
      {...dataGridRowVariants({
        density: componentProps.density,
        interactive: componentProps.interactive,
        selected: componentProps.selected,
        className: joinClassName(componentProps.className ?? ""),
      })}
    />
  );
}

export function DataGridCell(componentProps: DataGridCellProps) {
  const otherProps = omit(componentProps, "className", "tone");

  return (
    <div
      {...otherProps}
      {...dataGridCellVariants({
        tone: componentProps.tone,
        className: joinClassName(componentProps.className ?? ""),
      })}
    />
  );
}
