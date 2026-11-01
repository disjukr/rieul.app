import { style, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { className as joinClassName } from "../class-name.ts";

export interface PropertyListProps
  extends JSX.HTMLAttributes<HTMLDListElement> {
  className?: string;
}

export function PropertyList(componentProps: PropertyListProps) {
  const otherProps = omit(componentProps, "className");

  return (
    <dl
      {...otherProps}
      class={joinClassName(
        styles.propertyList().class,
        componentProps.className,
      )}
    />
  );
}

export interface PropertyListItemProps
  extends JSX.HTMLAttributes<HTMLDivElement> {
  className?: string;
  label: JSX.Element;
  valueClassName?: string;
  variant?: "default" | "white";
}

export function PropertyListItem(componentProps: PropertyListItemProps) {
  const otherProps = omit(
    componentProps,
    "children",
    "className",
    "label",
    "valueClassName",
    "variant",
  );

  return (
    <div
      {...otherProps}
      class={joinClassName(
        styles.propertyListItem().class,
        (componentProps.variant ?? "default") === "white" &&
          styles.propertyListItemWhite().class,
        componentProps.className,
      )}
    >
      <dt>{componentProps.label}</dt>
      <dd
        class={joinClassName(
          styles.propertyListValueCell().class,
          componentProps.valueClassName,
        )}
      >
        {componentProps.children}
      </dd>
    </div>
  );
}

export interface PropertyValueProps extends JSX.HTMLAttributes<HTMLElement> {
  className?: string;
}

export function PropertyValue(componentProps: PropertyValueProps) {
  const otherProps = omit(componentProps, "className");

  return (
    <code
      {...otherProps}
      class={joinClassName(
        styles.propertyValue().class,
        componentProps.className,
      )}
    />
  );
}

namespace styles {
  export const propertyList = style({
    display: "grid",
    gridTemplateColumns: "repeat(1,minmax(0,1fr))",
    margin: "0",
    minWidth: "0",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    borderRadius: "0.5rem",
    backgroundColor: theme.bgPrimary,
    selectors: {
      "&>div+div>dt": {
        boxShadow:
          "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 0 1px 0 var(--rieul-border-light)",
      },
    },
    containerType: "inline-size",
    "@container (min-width: 520px)": {
      selectors: {
        "&>div+div>dd": {
          boxShadow:
            "inset 1px 0 0 var(--rieul-border-light),inset 0 1px 0 var(--rieul-border-light)",
        },
      },
    },
  });
  export const propertyListItem = style({
    display: "grid",
    selectors: {
      "& dt": {
        margin: "0",
        boxSizing: "border-box",
        minWidth: "0",
        backgroundColor: theme.bgSubtle,
        paddingLeft: "1rem",
        paddingRight: "1rem",
        paddingTop: "0.5rem",
        paddingBottom: "0.5rem",
        fontSize: "12px",
        color: theme.textTertiary,
        fontWeight: 700,
      },
      "& dd": {
        boxShadow:
          "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 0 1px 0 var(--rieul-border-light)",
      },
    },
    minWidth: "0",
    backgroundColor: theme.bgPrimary,
    "@container (min-width: 520px)": {
      gridTemplateColumns: "minmax(120px,180px) minmax(0,1fr)",
      selectors: {
        "& dt": {
          paddingTop: "1rem",
          paddingBottom: "1rem",
        },
        "& dd": {
          boxShadow:
            "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), inset 1px 0 0 var(--rieul-border-light)",
        },
      },
    },
  });
  export const propertyListItemWhite = style({
    selectors: {
      "& dt": {
        backgroundColor: "var(--rieul-bg-primary) !important",
      },
    },
  });
  export const propertyListValueCell = style({
    overflowWrap: "anywhere",
    display: "grid",
    margin: "0",
    boxSizing: "border-box",
    minWidth: "0",
    width: "100%",
    alignSelf: "stretch",
    justifyItems: "start",
    justifySelf: "stretch",
    gap: "7px",
    backgroundColor: theme.bgPrimary,
    padding: "1rem",
    fontSize: "1rem",
    color: theme.textPrimary,
  });
  export const propertyValue = style({
    overflowWrap: "anywhere",
    display: "inline-block",
    maxWidth: "100%",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    borderRadius: "0.25rem",
    backgroundColor: theme.bgControlDisabled,
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    color: theme.textPrimary,
    lineHeight: 1.4,
    fontFamily:
      'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
  });
}
