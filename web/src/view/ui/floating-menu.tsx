import { Portal, type JSX } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { createEffect, omit, type Accessor } from "solid-js";
import { className as joinClassName } from "../class-name.ts";
const menuVariants = cva([
  "grid gap-[2px] border border-[var(--rieul-border-light)]",
  "bg-[var(--rieul-bg-primary)] rounded-[var(--rieul-radius-sm)] p-0",
  "shadow-rieul-menu outline-none",
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
    "data-[highlighted]:bg-[var(--rieul-bg-menu-hover)]",
    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-48",
  ],
  {
    variants: {
      tone: {
        danger: [
          "text-[var(--rieul-danger)]",
          "data-[highlighted]:bg-[var(--rieul-danger-soft-hover)]",
          "data-[highlighted]:text-[var(--rieul-danger-hover)]",
        ],
        neutral: "text-[var(--rieul-text-primary)]",
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
  "aria-label"?: string;
  align?: "start" | "center" | "end";
  anchorRef?: { current: Element | null };
  children: JSX.Element;
  className?: string;
  menuRef?: { current: HTMLDivElement | null };
  position?: FloatingMenuPosition;
  role?: JSX.HTMLAttributes<HTMLDivElement>["role"];
  strategy?: "absolute" | "fixed";
  style?: JSX.CSSProperties;
  onMouseDown?: (event: MouseEvent & { currentTarget: HTMLDivElement }) => void;
}

export interface FloatingMenuItemProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "className">,
    VariantProps<typeof menuItemVariants> {
  className?: string;
  type?: "button";
}

export interface FloatingMenuSize {
  itemCount: number;
  width: number;
}

export function FloatingMenu(props: FloatingMenuProps) {
  let popup!: HTMLDivElement;
  createEffect(
    () => true,
    () => {
      const previous = document.activeElement;
      if (props.menuRef) props.menuRef.current = popup;
      (
        popup.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)") ??
        popup
      ).focus({ preventScroll: true });
      return () => {
        if (
          previous instanceof HTMLElement &&
          previous.isConnected &&
          (document.activeElement === document.body ||
            popup.contains(document.activeElement))
        )
          previous.focus();
      };
    },
  );
  createEffect(
    () => ({
      position: props.position,
      anchor: props.anchorRef,
      align: props.align,
      strategy: props.strategy,
    }),
    ({ position, anchor, align, strategy }) => {
      function updatePosition() {
        const viewportWidth = globalThis.innerWidth;
        const viewportHeight = globalThis.innerHeight;
        popup.style.maxWidth = `${Math.max(0, viewportWidth - viewportMargin * 2)}px`;
        popup.style.maxHeight = `${Math.max(0, Math.min(position?.maxHeight ?? Infinity, viewportHeight - viewportMargin * 2))}px`;
        popup.style.overflowY = "auto";
        const width = popup.offsetWidth;
        const height = popup.offsetHeight;
        const rect = anchor?.current?.getBoundingClientRect();
        let left =
          position?.left ??
          (rect
            ? align === "end"
              ? rect.right - width
              : align === "center"
                ? rect.left + (rect.width - width) / 2
                : rect.left
            : viewportMargin);
        let top = position?.top ?? rect?.bottom ?? viewportMargin;
        if (
          !position &&
          rect &&
          top + height > viewportHeight - viewportMargin &&
          rect.top - height >= viewportMargin
        )
          top = rect.top - height;
        left = clampViewportPosition(left, width, viewportWidth);
        top = clampViewportPosition(top, height, viewportHeight);
        popup.style.left = `${left + (strategy === "absolute" ? globalThis.scrollX : 0)}px`;
        popup.style.top = `${top + (strategy === "absolute" ? globalThis.scrollY : 0)}px`;
      }
      updatePosition();
      const observer = new ResizeObserver(updatePosition);
      observer.observe(popup);
      globalThis.addEventListener("resize", updatePosition);
      globalThis.addEventListener("scroll", updatePosition, true);
      return () => {
        observer.disconnect();
        globalThis.removeEventListener("resize", updatePosition);
        globalThis.removeEventListener("scroll", updatePosition, true);
      };
    },
  );
  function keydown(event: KeyboardEvent) {
    const items = [
      ...popup.querySelectorAll<HTMLButtonElement>(
        "[role=menuitem]:not(:disabled)",
      ),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
      next =
        Array.from(
          { length: items.length },
          (_, offset) => (index + offset + 1) % items.length,
        ).find((i) =>
          items[i].textContent
            ?.trim()
            .toLowerCase()
            .startsWith(event.key.toLowerCase()),
        ) ?? -1;

    if (next >= 0) {
      event.preventDefault();
      items[next]?.focus();
    }
  }
  return (
    <Portal>
      <div
        ref={popup}
        role={props.role ?? "menu"}
        aria-label={props["aria-label"]}
        tabindex={-1}
        class={joinClassName(
          menuVariants(),
          menuPositionerVariants({ strategy: props.strategy }),
          props.className,
        )}
        style={{
          position: props.strategy ?? "fixed",
          ...props.style,
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keydown}
        onMouseDown={(event) => {
          event.stopPropagation();
          props.onMouseDown?.(event);
        }}
      >
        {props.children}
      </div>
    </Portal>
  );
}
export function FloatingMenuItem(props: FloatingMenuItemProps) {
  const rest = omit(props, "className", "tone", "type");
  return (
    <button
      {...rest}
      type="button"
      role={props.role ?? "menuitem"}
      tabindex={-1}
      class={joinClassName(
        menuItemVariants({ tone: props.tone }),
        "focus:bg-[var(--rieul-bg-menu-hover)] hover:bg-[var(--rieul-bg-menu-hover)] disabled:opacity-48",
        props.className,
      )}
    />
  );
}

export function floatingMenuHeight(itemCount: number): number {
  return (
    menuBorderSize +
    menuPaddingBlock +
    itemCount * floatingMenuItemHeightPx +
    Math.max(0, itemCount - 1) * menuItemGap
  );
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
  return clampFloatingMenuPosition(rect.right - width, rect.bottom + gap, {
    itemCount,
    width,
  });
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
  const belowMaxHeight =
    globalThis.innerHeight - rect.bottom - gap - viewportMargin;
  const aboveMaxHeight = rect.top - gap - viewportMargin;
  const openAbove =
    belowMaxHeight < minHeight && aboveMaxHeight > belowMaxHeight;
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
  open: Accessor<boolean>,
  menuRef: { current: HTMLElement | null },
  onClose: () => void,
  options?: { closeOnScroll?: boolean },
) {
  createEffect(open, (isOpen) => {
    if (!isOpen) return;

    function closeOnPointer(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Tab") onClose();
    }

    function closeOnResize() {
      onClose();
    }

    function closeOnScroll(event: Event) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    }

    // Effects can mount before the opening click finishes bubbling.
    const install = globalThis.setTimeout(() => {
      globalThis.addEventListener("click", closeOnPointer);
      globalThis.addEventListener("contextmenu", closeOnPointer);
    }, 0);
    globalThis.addEventListener("keydown", closeOnEscape);
    globalThis.addEventListener("resize", closeOnResize);
    if (options?.closeOnScroll) {
      globalThis.addEventListener("scroll", closeOnScroll, true);
    }
    return () => {
      globalThis.clearTimeout(install);
      globalThis.removeEventListener("click", closeOnPointer);
      globalThis.removeEventListener("contextmenu", closeOnPointer);
      globalThis.removeEventListener("keydown", closeOnEscape);
      globalThis.removeEventListener("resize", closeOnResize);
      if (options?.closeOnScroll) {
        globalThis.removeEventListener("scroll", closeOnScroll, true);
      }
    };
  });
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
