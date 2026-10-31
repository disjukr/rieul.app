import type { JSX } from "@solidjs/web";
import { cva } from "class-variance-authority";
import {
  createContext,
  createSignal,
  createUniqueId,
  omit,
  useContext,
  type Accessor,
} from "solid-js";
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
const tabPanelClassName =
  "block h-full min-h-0 w-full min-w-0 overflow-hidden [hidden]:hidden";

const TabsContext = createContext<{
  value: Accessor<string>;
  select(value: string): void;
  id: string;
}>();
export function TabsRoot(props: {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  children?: JSX.Element;
  className?: string;
}) {
  const [value, setValue] = createSignal(props.defaultValue ?? "");
  const context = {
    value: () => props.value ?? value(),
    select(v: string) {
      setValue(v);
      props.onValueChange?.(v);
    },
    id: createUniqueId(),
  };
  return (
    <TabsContext value={context}>
      <div class={props.className}>{props.children}</div>
    </TabsContext>
  );
}
export function TabsList(
  props: JSX.HTMLAttributes<HTMLDivElement> & { className?: string },
) {
  const rest = omit(props, "className");
  return (
    <div
      {...rest}
      role="tablist"
      class={joinClassName(tabListClassName, props.className)}
      onKeyDown={(event) => {
        const tabs = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "[role=tab]:not(:disabled)",
          ),
        ];
        const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "ArrowRight"
            ? (i + 1) % tabs.length
            : event.key === "ArrowLeft"
              ? (i - 1 + tabs.length) % tabs.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : -1;
        if (next >= 0) {
          event.preventDefault();
          tabs[next]?.focus();
          tabs[next]?.click();
        }
      }}
    />
  );
}
export interface TabsTabProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  value: string;
  className?: string;
  density?: "compact" | "regular";
}
export function TabsTab(props: TabsTabProps) {
  const context = useContext(TabsContext);
  const rest = omit(props, "value", "className", "density");
  return (
    <button
      {...rest}
      type="button"
      role="tab"
      id={`${context.id}-tab-${props.value}`}
      aria-controls={`${context.id}-panel-${props.value}`}
      aria-selected={context.value() === props.value ? "true" : "false"}
      tabindex={context.value() === props.value ? 0 : -1}
      data-selected={context.value() === props.value ? "" : undefined}
      class={joinClassName(
        tabClassName({ density: props.density }),
        props.className,
      )}
      onClick={() => context.select(props.value)}
    />
  );
}
export function TabsPanel(
  props: JSX.HTMLAttributes<HTMLDivElement> & {
    value: string;
    className?: string;
  },
) {
  const context = useContext(TabsContext);
  const rest = omit(props, "value", "className");
  return (
    <div
      {...rest}
      role="tabpanel"
      id={`${context.id}-panel-${props.value}`}
      aria-labelledby={`${context.id}-tab-${props.value}`}
      hidden={context.value() !== props.value}
      class={joinClassName(tabPanelClassName, props.className)}
    />
  );
}
