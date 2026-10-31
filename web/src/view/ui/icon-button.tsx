import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { Button, type ButtonProps } from "./button.tsx";

export interface IconButtonProps
  extends Omit<ButtonProps, "aria-label" | "children" | "size"> {
  "aria-label": string;
  children: JSX.Element;
}

export function IconButton(componentProps: IconButtonProps) {
  const otherProps = omit(componentProps, "children", "variant");

  return (
    <Button
      {...otherProps}
      size="icon"
      variant={componentProps.variant ?? "ghost"}
    >
      {componentProps.children}
    </Button>
  );
}
