import { style, variants, theme } from "../../zyzz.config.ts";
import type { JSX } from "@solidjs/web";
import {
  createContext,
  createSignal,
  createUniqueId,
  omit,
  useContext,
  type Accessor,
} from "solid-js";
import { className as joinClassName } from "../class-name.ts";

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
      class={joinClassName(styles.tabList().class, props.className)}
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
      {...variants({
        base: {
          fontFamily: "inherit",
          minWidth: "0",
          display: "inline-flex",
          cursor: "pointer",
          WebkitAppearance: "none",
          appearance: "none",
          alignItems: "center",
          justifyContent: "center",
          borderWidth: "0px",
          backgroundColor: theme.bgMuted,
          selectors: {
            "&[data-selected]": {
              backgroundColor: theme.bgPrimary,
              color: theme.textPrimary,
            },
          },
          color: theme.textControl,
          fontWeight: 700,
          lineHeight: 1.6,
        },
        variants: {
          density: {
            compact: {
              height: "2em",
              paddingLeft: "6px",
              paddingRight: "6px",
            },
            regular: {
              height: "34px",
              paddingLeft: "10px",
              paddingRight: "10px",
            },
          },
        },
        defaultVariants: {
          density: "compact",
        },
      })({
        density: props.density,
        className: joinClassName(props.className ?? ""),
      })}
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
      class={joinClassName(styles.tabPanel().class, props.className)}
    />
  );
}

namespace styles {
  export const tabList = style({
    minWidth: "0",
    display: "flex",
    alignItems: "flex-end",
    overflow: "visible",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderLight,
    backgroundColor: theme.bgHeader,
  });
  export const tabPanel = style({
    display: "block",
    height: "100%",
    minHeight: "0",
    minWidth: "0",
    width: "100%",
    overflow: "hidden",
  });
}
