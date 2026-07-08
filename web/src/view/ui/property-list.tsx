import type { HTMLAttributes, ReactNode } from "react";
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

export interface PropertyListProps extends HTMLAttributes<HTMLDListElement> {
}

export function PropertyList({ className, ...props }: PropertyListProps) {
  return (
    <dl
      {...props}
      className={joinClassName(propertyListClassName, className)}
    />
  );
}

export interface PropertyListItemProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  valueClassName?: string;
  variant?: "default" | "white";
}

export function PropertyListItem(
  {
    children,
    className,
    label,
    valueClassName,
    variant = "default",
    ...props
  }: PropertyListItemProps,
) {
  return (
    <div
      {...props}
      className={joinClassName(
        propertyListItemClassName,
        variant === "white" && propertyListItemWhiteClassName,
        className,
      )}
    >
      <dt>{label}</dt>
      <dd
        className={joinClassName(
          propertyListValueCellClassName,
          valueClassName,
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export interface PropertyValueProps extends HTMLAttributes<HTMLElement> {
}

export function PropertyValue({ className, ...props }: PropertyValueProps) {
  return (
    <code
      {...props}
      className={joinClassName(propertyValueClassName, className)}
    />
  );
}
