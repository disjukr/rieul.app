import type { HTMLAttributes, ReactNode } from "react";
import { className as joinClassName } from "../class-name.ts";

const propertyListClassName = [
  "@container m-0 grid min-w-0 grid-cols-1 gap-[1px] overflow-hidden",
  "rounded-[8px] border border-[#d8dde7] bg-[#d8dde7]",
].join(" ");

const propertyListItemClassName = [
  "grid min-w-0 gap-[1px] bg-[#d8dde7]",
  "@[520px]:grid-cols-[minmax(120px,180px)_minmax(0,1fr)]",
  "[&_dt]:m-0 [&_dt]:min-w-0 [&_dt]:bg-[#fbfcfe]",
  "[&_dt]:px-[14px] [&_dt]:py-[10px] [&_dt]:text-[12px]",
  "[&_dt]:font-700 [&_dt]:text-[#667085]",
].join(" ");

const propertyListItemWhiteClassName = "[&_dt]:!bg-white";
const propertyListValueCellClassName = [
  "m-0 box-border grid min-w-0 w-full self-stretch justify-self-stretch",
  "justify-items-start gap-[7px] bg-white px-[14px] py-[10px]",
  "text-[14px] text-[#20242d] [overflow-wrap:anywhere]",
].join(" ");

const propertyValueClassName = [
  "inline-block max-w-full rounded-[4px] border border-[#d8dde7]",
  "bg-[#f4f6fa] px-[4px] py-[1px] font-mono text-[0.92em]",
  "leading-[1.4] text-[#20242d] [overflow-wrap:anywhere]",
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
