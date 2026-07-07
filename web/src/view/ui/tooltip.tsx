import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { cva } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const tooltipPopupVariants = cva([
  "z-[40] rounded-[var(--wgo-radius-md)] bg-[var(--wgo-bg-inverse)] text-[var(--wgo-text-inverse)]",
  "px-[9px] py-[6px] text-[12px] font-650 leading-none",
  "shadow-[var(--wgo-shadow-tooltip)]",
]);
const tooltipArrowClassName = "fill-[var(--wgo-bg-inverse)]";

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
