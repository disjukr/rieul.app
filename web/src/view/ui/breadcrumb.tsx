import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { className as joinClassName } from "../class-name.ts";

export interface BreadcrumbItem {
  label: ReactNode;
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
  "[&_svg]:flex-[0_0_auto] [&_svg]:text-[var(--wgo-text-disabled)]",
  "[&_button]:inline-flex [&_button]:appearance-none [&_button]:cursor-pointer",
  "[&_button]:items-center [&_button]:[font-family:inherit]",
  "[&_button]:h-[2rem] [&_button]:min-w-0 [&_button]:max-w-[180px]",
  "[&_button]:overflow-hidden [&_button]:text-ellipsis",
  "[&_button]:whitespace-nowrap [&_button]:rounded-[0.5rem]",
  "[&_button]:border-transparent [&_button]:bg-transparent",
  "[&_button]:px-[0.5rem] [&_button]:font-750",
  "[&_button]:text-[var(--wgo-text-control)] [&_button:hover]:bg-[var(--wgo-bg-hover)]",
  "[&_span]:inline-flex [&_span]:h-[2rem] [&_span]:min-w-0",
  "[&_span]:max-w-[240px] [&_span]:items-center [&_span]:overflow-hidden",
  "[&_span]:text-ellipsis [&_span]:whitespace-nowrap",
  "[&_span]:px-[0.5rem] [&_span]:font-750 [&_span]:text-[var(--wgo-text-primary)]",
].join(" ");
const breadcrumbMutedClassName = "text-[var(--wgo-text-tertiary)]";

export function Breadcrumb({ ariaLabel, className, items }: BreadcrumbProps) {
  return (
    <nav
      className={joinClassName(breadcrumbClassName, className)}
      aria-label={ariaLabel}
    >
      {items.map((item, index) => (
        <BreadcrumbPart key={index} item={item} showSeparator={index > 0} />
      ))}
    </nav>
  );
}

interface BreadcrumbPartProps {
  item: BreadcrumbItem;
  showSeparator: boolean;
}

function BreadcrumbPart({ item, showSeparator }: BreadcrumbPartProps) {
  return (
    <>
      {showSeparator ? <ChevronRight size={12} /> : null}
      {item.onClick
        ? (
          <button type="button" onClick={item.onClick} title={item.title}>
            {item.label}
          </button>
        )
        : (
          <span
            className={item.muted ? breadcrumbMutedClassName : undefined}
            title={item.title}
          >
            {item.label}
          </span>
        )}
    </>
  );
}
