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

const breadcrumbClassName = [
  "flex h-[2rem] min-h-[2rem] min-w-0 items-center gap-[0.5rem] overflow-hidden",
  "[&_svg]:flex-[0_0_auto] [&_svg]:text-[var(--rieul-text-disabled)]",
  "[&_button]:inline-flex [&_button]:appearance-none [&_button]:cursor-pointer",
  "[&_button]:items-center [&_button]:[font-family:inherit]",
  "[&_button]:h-[2rem] [&_button]:min-w-0 [&_button]:max-w-[180px]",
  "[&_button]:overflow-hidden [&_button]:text-ellipsis",
  "[&_button]:whitespace-nowrap [&_button]:rounded-[0.5rem]",
  "[&_button]:border-transparent [&_button]:bg-transparent",
  "[&_button]:px-[0.5rem] [&_button]:font-750",
  "[&_button]:text-[var(--rieul-text-control)] [&_button:hover]:bg-[var(--rieul-bg-hover)]",
  "[&_span]:inline-flex [&_span]:h-[2rem] [&_span]:min-w-0",
  "[&_span]:max-w-[240px] [&_span]:items-center [&_span]:overflow-hidden",
  "[&_span]:text-ellipsis [&_span]:whitespace-nowrap",
  "[&_span]:px-[0.5rem] [&_span]:font-750 [&_span]:text-[var(--rieul-text-primary)]",
].join(" ");
const breadcrumbMutedClassName = "text-[var(--rieul-text-tertiary)]";

export function Breadcrumb(componentProps: BreadcrumbProps) {
  return (
    <nav
      class={joinClassName(breadcrumbClassName, componentProps.className)}
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
            componentProps.item.muted ? breadcrumbMutedClassName : undefined
          }
          title={componentProps.item.title}
        >
          {componentProps.item.label}
        </span>
      )}
    </>
  );
}
