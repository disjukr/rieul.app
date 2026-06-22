import type { ButtonHTMLAttributes } from "react";
import { className as joinClassName } from "../class-name.ts";

const buttonClassName = [
  "inline-flex min-h-[34px] appearance-none items-center justify-center gap-[7px]",
  "rounded-[6px] border border-[#c9d0dc] bg-white px-[10px]",
  "cursor-pointer text-[#20242d] [font:inherit]",
  "hover:border-[#7c96c4] hover:bg-[#f7faff]",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4f8cff]",
  "focus-visible:outline-offset-1",
  "disabled:cursor-not-allowed disabled:opacity-48",
].join(" ");

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
}

export function Button(
  { className, type = "button", ...props }: ButtonProps,
) {
  return (
    <button
      {...props}
      type={type}
      className={joinClassName(buttonClassName, className)}
    />
  );
}
