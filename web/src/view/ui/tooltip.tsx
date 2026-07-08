import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { cva } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const tooltipPopupVariants = cva([
  "z-[40] rounded-[var(--rieul-radius-md)] bg-[var(--rieul-bg-inverse)] text-[var(--rieul-text-inverse)]",
  "px-[9px] py-[6px] text-[12px] font-650 leading-none",
  "shadow-[var(--rieul-shadow-tooltip)]",
]);
const tooltipArrowClassName = "fill-[var(--rieul-bg-inverse)]";

interface AppTooltipProps {
  children: ReactElement;
  className?: string;
  label: ReactNode;
}

export function AppTooltip({ children, className, label }: AppTooltipProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="right" align="center" sideOffset={12}>
          <Tooltip.Popup
            className={joinClassName(tooltipPopupVariants(), className)}
          >
            <Tooltip.Arrow className={tooltipArrowClassName} />
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
