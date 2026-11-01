import { className as joinClassName } from "../class-name.ts";
import { variants, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import type { Props } from "zyzz";

const surfaceVariants = variants({
  base: {
    minWidth: "0",
  },
  variants: {
    border: {
      none: {},
      subtle: {
        borderWidth: "1px",
        borderColor: theme.borderLight,
      },
    },
    radius: {
      none: {
        borderRadius: "0",
      },
      md: {
        borderRadius: theme.radiusMd,
      },
      lg: {
        borderRadius: theme.radiusLg,
      },
    },
    variant: {
      canvas: {
        backgroundColor: theme.bgCanvas,
      },
      header: {
        backgroundColor: theme.bgHeader,
      },
      primary: {
        backgroundColor: theme.bgPrimary,
      },
      secondary: {
        backgroundColor: theme.bgSecondary,
      },
      subtle: {
        backgroundColor: theme.bgSubtle,
      },
    },
  },
  defaultVariants: {
    border: "none",
    radius: "none",
    variant: "primary",
  },
});

const surfaceHeaderVariants = variants({
  base: {
    minWidth: "0",
    display: "flex",
    alignItems: "center",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderLight,
    backgroundColor: theme.bgHeader,
  },
  variants: {
    density: {
      compact: {
        minHeight: "2rem",
        paddingLeft: "8px",
        paddingRight: "8px",
      },
      regular: {
        minHeight: "48px",
        paddingLeft: "1rem",
        paddingRight: "1rem",
      },
    },
  },
  defaultVariants: {
    density: "compact",
  },
});

export interface SurfaceProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    Omit<
      Props.Variants<typeof surfaceVariants>,
      "className" | "style" | "vars"
    > {
  className?: string;
}

export interface SurfaceHeaderProps
  extends JSX.HTMLAttributes<HTMLDivElement>,
    Omit<
      Props.Variants<typeof surfaceHeaderVariants>,
      "className" | "style" | "vars"
    > {
  className?: string;
}

export function Surface(componentProps: SurfaceProps) {
  const otherProps = omit(
    componentProps,
    "border",
    "className",
    "radius",
    "variant",
  );

  return (
    <div
      {...otherProps}
      {...surfaceVariants({
        border: componentProps.border,
        radius: componentProps.radius,
        variant: componentProps.variant,
        className: joinClassName(componentProps.className ?? ""),
      })}
    />
  );
}

export function SurfaceHeader(componentProps: SurfaceHeaderProps) {
  const otherProps = omit(componentProps, "className", "density");

  return (
    <div
      {...otherProps}
      {...surfaceHeaderVariants({
        density: componentProps.density,
        className: joinClassName(componentProps.className ?? ""),
      })}
    />
  );
}
