import { Tabs } from "@base-ui/react/tabs";
import { cva } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const tabListClassName =
  "flex min-w-0 items-end overflow-visible border-b border-b-[var(--rieul-border-light)] bg-[var(--rieul-bg-header)]";
const tabClassName = cva(
  [
    "inline-flex min-w-0 appearance-none items-center justify-center",
    "border-0 bg-[var(--rieul-bg-muted)] text-[var(--rieul-text-control)]",
    "[font-family:inherit] font-700 leading-[1.6] cursor-pointer",
    "data-[selected]:bg-[var(--rieul-bg-primary)]",
    "data-[selected]:text-[var(--rieul-text-primary)]",
  ],
  {
    variants: {
      density: {
        compact: "h-[2em] px-[6px]",
        regular: "h-[34px] px-[10px]",
      },
    },
    defaultVariants: {
      density: "compact",
    },
  },
);
const tabPanelClassName = "block h-full min-h-0 w-full min-w-0 overflow-hidden";

export const TabsRoot = Tabs.Root;

type TabsListProps =
  & Omit<
    React.ComponentPropsWithoutRef<typeof Tabs.List>,
    "className"
  >
  & { className?: string };

export function TabsList(
  { className, ...props }: TabsListProps,
) {
  return (
    <Tabs.List
      {...props}
      className={joinClassName(tabListClassName, className)}
    />
  );
}

export interface TabsTabProps
  extends Omit<React.ComponentPropsWithoutRef<typeof Tabs.Tab>, "className"> {
  className?: string;
  density?: "compact" | "regular";
}

export function TabsTab({ className, density, ...props }: TabsTabProps) {
  return (
    <Tabs.Tab
      {...props}
      className={joinClassName(tabClassName({ density }), className)}
    />
  );
}

type TabsPanelProps =
  & Omit<
    React.ComponentPropsWithoutRef<typeof Tabs.Panel>,
    "className"
  >
  & { className?: string };

export function TabsPanel(
  { className, ...props }: TabsPanelProps,
) {
  return (
    <Tabs.Panel
      {...props}
      className={joinClassName(tabPanelClassName, className)}
    />
  );
}
