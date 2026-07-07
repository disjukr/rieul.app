import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  useEffect,
} from "react";
import { Menu } from "@base-ui/react/menu";
import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";

const menuVariants = cva([
  "grid gap-[2px] border border-[var(--wgo-border-light)]",
  "bg-[var(--wgo-bg-primary)] rounded-[var(--wgo-radius-sm)] p-0",
  "shadow-wgo-menu outline-none",
]);
const menuPositionerVariants = cva("z-[30]", {
  variants: {
    strategy: {
      absolute: "absolute",
      fixed: "fixed",
    },
  },
  defaultVariants: {
    strategy: "fixed",
  },
});
const menuItemVariants = cva(
  [
    "inline-flex h-[2rem] min-h-[2rem] w-full appearance-none",
    "items-center justify-start gap-[7px] rounded-0 border-0 bg-transparent",
    "px-[8px] text-left [font:inherit]",
    "cursor-pointer outline-none",
    "data-[highlighted]:bg-[var(--wgo-bg-menu-hover)]",
    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-48",
  ],
  {
    variants: {
      tone: {
        danger: [
          "text-[var(--wgo-danger)]",
          "data-[highlighted]:bg-[var(--wgo-danger-soft-hover)]",
          "data-[highlighted]:text-[var(--wgo-danger-hover)]",
        ],
        neutral: "text-[var(--wgo-text-primary)]",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);
const viewportMargin = 8;
const menuBorderSize = 2;
const menuPaddingBlock = 0;
const menuItemGap = 2;
export const floatingMenuItemHeightPx = 24;

export interface FloatingMenuPosition {
  left: number;
  top: number;
  maxHeight?: number;
}

export interface FloatingMenuProps {
  children: ReactNode;
  className?: string;
  menuRef?: RefObject<HTMLDivElement | null>;
  position?: FloatingMenuPosition;
  role?: string;
  strategy?: "absolute" | "fixed";
  style?: CSSProperties;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
}

export interface FloatingMenuItemProps extends
  Omit<
    ComponentPropsWithoutRef<typeof Menu.Item>,
    "className"
  >,
  VariantProps<typeof menuItemVariants> {
  className?: string;
  type?: "button";
}

export interface FloatingMenuSize {
  itemCount: number;
  width: number;
}

export function FloatingMenu(
  {
    children,
    className,
    menuRef,
    position,
    role = "menu",
    strategy = "fixed",
    style,
    onMouseDown,
  }: FloatingMenuProps,
) {
  const popup = (
    <Menu.Popup
      ref={menuRef}
      className={joinClassName(
        strategy === "absolute" && "absolute",
        menuVariants(),
        className,
      )}
      role={role}
      style={strategy === "absolute" ? { ...position, ...style } : style}
      finalFocus={false}
      onMouseDown={(event) => {
        event.stopPropagation();
        onMouseDown?.(event);
      }}
    >
      {children}
    </Menu.Popup>
  );

  if (strategy === "absolute") {
    return (
      <Menu.Root open modal={false}>
        {popup}
      </Menu.Root>
    );
  }

  return (
    <Menu.Root open modal={false}>
      <Menu.Portal>
        <Menu.Positioner
          className={menuPositionerVariants({ strategy })}
          style={{ ...position }}
        >
          {popup}
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function FloatingMenuItem(
  { className, tone, type: _type = "button", ...props }: FloatingMenuItemProps,
) {
  return (
    <Menu.Item
      {...props}
      role={props.role ?? "menuitem"}
      className={joinClassName(
        menuItemVariants({ tone }),
        className,
      )}
    />
  );
}

export function floatingMenuHeight(itemCount: number): number {
  return menuBorderSize + menuPaddingBlock +
    itemCount * floatingMenuItemHeightPx +
    Math.max(0, itemCount - 1) * menuItemGap;
}

export function clampFloatingMenuPosition(
  left: number,
  top: number,
  { itemCount, width }: FloatingMenuSize,
): FloatingMenuPosition {
  return {
    left: clampViewportPosition(left, width, globalThis.innerWidth),
    top: clampViewportPosition(
      top,
      floatingMenuHeight(itemCount),
      globalThis.innerHeight,
    ),
  };
}

export function rightAlignedFloatingMenuPosition(
  rect: DOMRect,
  { itemCount, width }: FloatingMenuSize,
  gap = 0,
): FloatingMenuPosition {
  return clampFloatingMenuPosition(
    rect.right - width,
    rect.bottom + gap,
    { itemCount, width },
  );
}

export function floatingMenuPositionFromRect(
  rect: DOMRect,
  {
    itemCount,
    maxHeight = 360,
    minHeight = 120,
    width,
  }: FloatingMenuSize & { maxHeight?: number; minHeight?: number },
  gap = 0,
): FloatingMenuPosition {
  const estimatedHeight = Math.min(maxHeight, floatingMenuHeight(itemCount));
  const left = clampViewportPosition(
    rect.right - width,
    width,
    globalThis.innerWidth,
  );
  const belowMaxHeight = globalThis.innerHeight - rect.bottom - gap -
    viewportMargin;
  const aboveMaxHeight = rect.top - gap - viewportMargin;
  const openAbove = belowMaxHeight < minHeight &&
    aboveMaxHeight > belowMaxHeight;
  const availableHeight = openAbove ? aboveMaxHeight : belowMaxHeight;
  const maxMenuHeight = Math.max(
    Math.min(minHeight, Math.max(0, availableHeight)),
    Math.min(estimatedHeight, availableHeight),
  );
  const top = openAbove
    ? Math.max(viewportMargin, rect.top - gap - maxMenuHeight)
    : rect.bottom + gap;

  return { left, top, maxHeight: maxMenuHeight };
}

export function useFloatingMenuDismiss(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  options?: { closeOnScroll?: boolean },
) {
  useEffect(() => {
    if (!open) return;

    function closeOnPointer(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    function closeOnResize() {
      onClose();
    }

    function closeOnScroll(event: Event) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    }

    globalThis.addEventListener("mousedown", closeOnPointer);
    globalThis.addEventListener("keydown", closeOnEscape);
    globalThis.addEventListener("resize", closeOnResize);
    if (options?.closeOnScroll) {
      globalThis.addEventListener("scroll", closeOnScroll, true);
    }
    return () => {
      globalThis.removeEventListener("mousedown", closeOnPointer);
      globalThis.removeEventListener("keydown", closeOnEscape);
      globalThis.removeEventListener("resize", closeOnResize);
      if (options?.closeOnScroll) {
        globalThis.removeEventListener("scroll", closeOnScroll, true);
      }
    };
  }, [menuRef, onClose, open, options?.closeOnScroll]);
}

function clampViewportPosition(
  value: number,
  size: number,
  viewportSize: number,
): number {
  const max = viewportSize - size - viewportMargin;
  if (max < viewportMargin) return viewportMargin;
  return Math.max(viewportMargin, Math.min(value, max));
}
