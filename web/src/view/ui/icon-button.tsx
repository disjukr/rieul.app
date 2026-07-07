import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./button.tsx";

export interface IconButtonProps
  extends Omit<ButtonProps, "aria-label" | "children" | "size"> {
  "aria-label": string;
  children: ReactNode;
}

export function IconButton(
  { children, variant = "ghost", ...props }: IconButtonProps,
) {
  return (
    <Button {...props} size="icon" variant={variant}>
      {children}
    </Button>
  );
}
