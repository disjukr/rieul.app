import { style, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";

import { ChevronRight } from "../../solid/icons.tsx";
import { className as joinClassName } from "../class-name.ts";

export interface BreadcrumbItem {
  label: JSX.Element;
  muted?: boolean;
  onClick?: () => void;
  title?: string;
}

interface BreadcrumbProps {
  ariaLabel: string;
  className?: string;
  items: BreadcrumbItem[];
}

export function Breadcrumb(componentProps: BreadcrumbProps) {
  return (
    <nav
      class={joinClassName(styles.breadcrumb().class, componentProps.className)}
      aria-label={componentProps.ariaLabel}
    >
      {componentProps.items.map((item, index) => (
        <BreadcrumbPart item={item} showSeparator={index > 0} />
      ))}
    </nav>
  );
}

interface BreadcrumbPartProps {
  item: BreadcrumbItem;
  showSeparator: boolean;
}

function BreadcrumbPart(componentProps: BreadcrumbPartProps) {
  return (
    <>
      {componentProps.showSeparator ? <ChevronRight size={12} /> : null}
      {componentProps.item.onClick ? (
        <button
          type="button"
          onClick={() => componentProps.item.onClick?.()}
          title={componentProps.item.title}
        >
          {componentProps.item.label}
        </button>
      ) : (
        <span
          class={
            componentProps.item.muted
              ? styles.breadcrumbMuted().class
              : undefined
          }
          title={componentProps.item.title}
        >
          {componentProps.item.label}
        </span>
      )}
    </>
  );
}

namespace styles {
  export const breadcrumb = style({
    selectors: {
      "& button": {
        fontFamily: "inherit",
        height: "2rem",
        maxWidth: "180px",
        minWidth: "0",
        display: "inline-flex",
        cursor: "pointer",
        WebkitAppearance: "none",
        appearance: "none",
        alignItems: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        borderColor: "transparent",
        borderRadius: "0.5rem",
        backgroundColor: "transparent",
        paddingLeft: "0.5rem",
        paddingRight: "0.5rem",
        color: theme.textControl,
        fontWeight: 750,
      },
      "& span": {
        height: "2rem",
        minWidth: "0",
        maxWidth: "240px",
        display: "inline-flex",
        alignItems: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        paddingLeft: "0.5rem",
        paddingRight: "0.5rem",
        color: theme.textPrimary,
        fontWeight: 750,
      },
      "& svg": {
        flex: "0 0 auto",
        color: theme.textDisabled,
      },
      "& button:hover": {
        backgroundColor: theme.bgHover,
      },
    },
    height: "2rem",
    minWidth: "0",
    minHeight: "2rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    overflow: "hidden",
  });
  export const breadcrumbMuted = style({
    color: theme.textTertiary,
  });
}
