import { className as joinClassName } from "../class-name.ts";
import { variants, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import type { Props } from "zyzz";

const badgeVariants = variants({
  base: {
    maxWidth: "100%",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    whiteSpace: "nowrap",
    borderWidth: "1px",
    borderRadius: "9999px",
    fontWeight: 750,
    lineHeight: 1,
  },
  variants: {
    size: {
      md: {
        paddingLeft: "0.5rem",
        paddingRight: "0.5rem",
        paddingTop: "2px",
        paddingBottom: "2px",
        fontSize: "1rem",
      },
      sm: {
        paddingLeft: "4px",
        paddingRight: "4px",
        paddingTop: "0",
        paddingBottom: "0",
        fontSize: "11px",
      },
    },
    tone: {
      accent: {},
      danger: {},
      neutral: {},
      success: {},
      warning: {},
    },
    variant: {
      outline: {
        backgroundColor: "transparent",
      },
      soft: {},
      solid: {
        color: theme.textInverse,
      },
    },
  },
  compoundVariants: [
    {
      when: {
        tone: "neutral",
        variant: "soft",
      },
      style: {
        borderColor: theme.borderLight,
        backgroundColor: theme.bgControlDisabled,
        color: theme.textControl,
      },
    },
    {
      when: {
        tone: "neutral",
        variant: "outline",
      },
      style: {
        borderColor: theme.borderLight,
        color: theme.textSecondary,
      },
    },
    {
      when: {
        tone: "neutral",
        variant: "solid",
      },
      style: {
        borderColor: theme.textControl,
        backgroundColor: theme.textControl,
      },
    },
    {
      when: {
        tone: "accent",
        variant: "soft",
      },
      style: {
        borderColor: theme.accentSoftStrong,
        backgroundColor: theme.accentSoftStrong,
        color: theme.accent,
      },
    },
    {
      when: {
        tone: "accent",
        variant: "outline",
      },
      style: {
        borderColor: theme.accent,
        color: theme.accent,
      },
    },
    {
      when: {
        tone: "accent",
        variant: "solid",
      },
      style: {
        borderColor: theme.accent,
        backgroundColor: theme.accent,
      },
    },
    {
      when: {
        tone: "danger",
        variant: "soft",
      },
      style: {
        borderColor: theme.dangerSoftMuted,
        backgroundColor: theme.dangerSoftMuted,
        color: theme.danger,
      },
    },
    {
      when: {
        tone: "danger",
        variant: "outline",
      },
      style: {
        borderColor: theme.dangerBorder,
        color: theme.danger,
      },
    },
    {
      when: {
        tone: "danger",
        variant: "solid",
      },
      style: {
        borderColor: theme.danger,
        backgroundColor: theme.danger,
      },
    },
    {
      when: {
        tone: "success",
        variant: "soft",
      },
      style: {
        borderColor: theme.successSoft,
        backgroundColor: theme.successSoft,
        color: theme.success,
      },
    },
    {
      when: {
        tone: "success",
        variant: "outline",
      },
      style: {
        borderColor: theme.success,
        color: theme.success,
      },
    },
    {
      when: {
        tone: "success",
        variant: "solid",
      },
      style: {
        borderColor: theme.success,
        backgroundColor: theme.success,
      },
    },
    {
      when: {
        tone: "warning",
        variant: "soft",
      },
      style: {
        borderColor: theme.borderWarning,
        backgroundColor: theme.warningSoft,
        color: theme.warning,
      },
    },
    {
      when: {
        tone: "warning",
        variant: "outline",
      },
      style: {
        borderColor: theme.borderWarning,
        color: theme.warning,
      },
    },
    {
      when: {
        tone: "warning",
        variant: "solid",
      },
      style: {
        borderColor: theme.warning,
        backgroundColor: theme.warning,
      },
    },
  ],
  defaultVariants: {
    size: "md",
    tone: "neutral",
    variant: "soft",
  },
});

export interface BadgeProps
  extends JSX.HTMLAttributes<HTMLSpanElement>,
    Omit<Props.Variants<typeof badgeVariants>, "className" | "style" | "vars"> {
  className?: string;
}

export function Badge(componentProps: BadgeProps) {
  const otherProps = omit(
    componentProps,
    "className",
    "size",
    "tone",
    "variant",
  );

  return (
    <span
      {...otherProps}
      {...badgeVariants({
        size: componentProps.size,
        tone: componentProps.tone,
        variant: componentProps.variant,
        className: joinClassName(componentProps.className ?? ""),
      })}
    />
  );
}
