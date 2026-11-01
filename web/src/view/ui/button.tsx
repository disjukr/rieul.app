import { className as joinClassName } from "../class-name.ts";
import { variants, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import type { Props } from "zyzz";
import { omit } from "solid-js";

const buttonVariants = variants({
  base: {
    font: "inherit",
    display: "inline-flex",
    cursor: "pointer",
    selectors: {
      "&[data-disabled]": {
        cursor: "not-allowed",
        opacity: 0.48,
      },
      "&:disabled": {
        cursor: "not-allowed",
        opacity: 0.48,
      },
      "&:focus-visible": {
        outlineWidth: "2px",
        outlineColor: theme.focus,
        outlineOffset: "1px",
        outlineStyle: "solid",
      },
    },
    WebkitAppearance: "none",
    appearance: "none",
    alignItems: "center",
    justifyContent: "center",
    gap: "7px",
    borderWidth: "1px",
  },
  variants: {
    tone: {
      danger: {},
      neutral: {},
    },
    variant: {
      ghost: {
        borderColor: "transparent",
        backgroundColor: "transparent",
      },
      outline: {
        backgroundColor: theme.bgPrimary,
      },
      soft: {},
      solid: {},
    },
    size: {
      icon: {
        height: "34px",
        minHeight: "34px",
        minWidth: "34px",
        width: "34px",
        padding: "0",
      },
      md: {
        minHeight: "34px",
        borderRadius: theme.radiusMd,
        paddingLeft: "10px",
        paddingRight: "10px",
      },
      sm: {
        minHeight: "28px",
        borderRadius: theme.radiusSm,
        paddingLeft: "8px",
        paddingRight: "8px",
      },
    },
  },
  compoundVariants: [
    {
      when: {
        tone: "neutral",
        variant: "solid",
      },
      style: {
        borderColor: theme.borderMedium,
        selectors: {
          "&:hover": {
            borderColor: theme.borderActionHover,
            backgroundColor: theme.bgHoverWeak,
          },
        },
        backgroundColor: theme.bgPrimary,
        color: theme.textPrimary,
      },
    },
    {
      when: {
        tone: "neutral",
        variant: "outline",
      },
      style: {
        borderColor: theme.borderMedium,
        selectors: {
          "&:hover": {
            borderColor: theme.borderActionHover,
            backgroundColor: theme.bgHoverWeak,
          },
        },
        color: theme.textPrimary,
      },
    },
    {
      when: {
        tone: "neutral",
        variant: "soft",
      },
      style: {
        borderColor: theme.borderLight,
        backgroundColor: theme.bgSecondary,
        selectors: {
          "&:hover": {
            backgroundColor: theme.bgHover,
          },
        },
        color: theme.textPrimary,
      },
    },
    {
      when: {
        tone: "neutral",
        variant: "ghost",
      },
      style: {
        selectors: {
          "&:hover": {
            borderColor: theme.borderLight,
            backgroundColor: theme.bgSecondary,
          },
        },
        color: theme.textPrimary,
      },
    },
    {
      when: {
        tone: "danger",
        variant: "solid",
      },
      style: {
        borderColor: theme.danger,
        selectors: {
          "&:hover": {
            borderColor: theme.dangerHover,
            backgroundColor: theme.dangerHover,
          },
        },
        backgroundColor: theme.danger,
        color: theme.textInverse,
      },
    },
    {
      when: {
        tone: "danger",
        variant: "outline",
      },
      style: {
        borderColor: theme.dangerBorder,
        selectors: {
          "&:hover": {
            borderColor: theme.dangerBorderHover,
            backgroundColor: theme.dangerSoftHover,
            color: theme.dangerHover,
          },
        },
        color: theme.danger,
      },
    },
    {
      when: {
        tone: "danger",
        variant: "soft",
      },
      style: {
        borderColor: theme.dangerBorder,
        selectors: {
          "&:hover": {
            borderColor: theme.dangerBorderHover,
            backgroundColor: theme.dangerSoftHover,
            color: theme.dangerHover,
          },
        },
        backgroundColor: theme.dangerSoft,
        color: theme.danger,
      },
    },
    {
      when: {
        tone: "danger",
        variant: "ghost",
      },
      style: {
        selectors: {
          "&:hover": {
            borderColor: theme.dangerBorder,
            backgroundColor: theme.dangerSoftHover,
            color: theme.dangerHover,
          },
        },
        color: theme.danger,
      },
    },
  ],
  defaultVariants: {
    size: "md",
    tone: "neutral",
    variant: "solid",
  },
});

export interface ButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "className">,
    Omit<
      Props.Variants<typeof buttonVariants>,
      "className" | "style" | "vars"
    > {
  className?: string;
}

export function Button(componentProps: ButtonProps) {
  const otherProps = omit(
    componentProps,
    "className",
    "size",
    "tone",
    "type",
    "variant",
  );

  return (
    <button
      {...otherProps}
      type={componentProps.type ?? "button"}
      {...buttonVariants({
        size: componentProps.size,
        tone: componentProps.tone,
        variant: componentProps.variant,
        className: joinClassName(componentProps.className ?? ""),
      })}
    />
  );
}
