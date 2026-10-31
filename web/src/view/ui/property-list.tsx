import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { className as joinClassName } from "../class-name.ts";

const propertyListClassName = [
  "@container m-0 grid min-w-0 grid-cols-1 overflow-hidden",
  "rounded-[0.5rem] border border-[var(--rieul-border-light)] bg-[var(--rieul-bg-primary)]",
  "[&>div+div>dt]:shadow-[inset_0_1px_0_var(--rieul-border-light)]",
  "@[520px]:[&>div+div>dd]:[box-shadow:inset_1px_0_0_var(--rieul-border-light),inset_0_1px_0_var(--rieul-border-light)]",
].join(" ");

const propertyListItemClassName = [
  "grid min-w-0 bg-[var(--rieul-bg-primary)]",
  "@[520px]:grid-cols-[minmax(120px,180px)_minmax(0,1fr)]",
  "[&_dt]:m-0 [&_dt]:box-border [&_dt]:min-w-0 [&_dt]:bg-[var(--rieul-bg-subtle)]",
  "[&_dt]:px-[1rem] [&_dt]:py-[0.5rem] [&_dt]:text-[12px]",
  "[&_dt]:font-700 [&_dt]:text-[var(--rieul-text-tertiary)]",
  "@[520px]:[&_dt]:py-[1rem]",
  "[&_dd]:shadow-[inset_0_1px_0_var(--rieul-border-light)]",
  "@[520px]:[&_dd]:shadow-[inset_1px_0_0_var(--rieul-border-light)]",
].join(" ");

const propertyListItemWhiteClassName = "[&_dt]:!bg-[var(--rieul-bg-primary)]";
const propertyListValueCellClassName = [
  "m-0 box-border grid min-w-0 w-full self-stretch justify-self-stretch",
  "justify-items-start gap-[7px] bg-[var(--rieul-bg-primary)] p-[1rem]",
  "text-[1rem] text-[var(--rieul-text-primary)] [overflow-wrap:anywhere]",
].join(" ");

const propertyValueClassName = [
  "inline-block max-w-full rounded-[0.25rem] border border-[var(--rieul-border-light)]",
  "bg-[var(--rieul-bg-control-disabled)] px-[0.5rem] font-mono",
  "leading-[1.4] text-[var(--rieul-text-primary)] [overflow-wrap:anywhere]",
].join(" ");

export interface PropertyListProps
  extends JSX.HTMLAttributes<HTMLDListElement> {
  className?: string;
}

export function PropertyList(componentProps: PropertyListProps) {
  const otherProps = omit(componentProps, "className");

  return (
    <dl
      {...otherProps}
      class={joinClassName(propertyListClassName, componentProps.className)}
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
        propertyListItemClassName,
        (componentProps.variant ?? "default") === "white" &&
          propertyListItemWhiteClassName,
        componentProps.className,
      )}
    >
      <dt>{componentProps.label}</dt>
      <dd
        class={joinClassName(
          propertyListValueCellClassName,
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
      class={joinClassName(propertyValueClassName, componentProps.className)}
    />
  );
}
