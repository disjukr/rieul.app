import { Portal, type JSX } from "@solidjs/web";
import { createEffect, createSignal, createUniqueId } from "solid-js";
interface AppTooltipProps {
  children: JSX.Element;
  className?: string;
  label: JSX.Element;
}
export function AppTooltip(props: AppTooltipProps) {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  let anchor!: HTMLSpanElement;
  let popup!: HTMLSpanElement;
  createEffect(open, (visible) => {
    if (!visible) return;
    const trigger =
      anchor.querySelector<HTMLElement>("button, a[href], input, [tabindex]") ??
      anchor.firstElementChild;
    if (!trigger) return;
    const previous = trigger.getAttribute("aria-describedby");
    trigger.setAttribute(
      "aria-describedby",
      [previous, id].filter(Boolean).join(" "),
    );
    function updatePosition() {
      const rect = trigger!.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const right = rect.right + 12;
      const preferredLeft =
        right + width <= globalThis.innerWidth - 8
          ? right
          : rect.left - 12 - width;
      popup.style.left = `${Math.max(8, Math.min(preferredLeft, globalThis.innerWidth - width - 8))}px`;
      popup.style.top = `${Math.max(8, Math.min(rect.top + (rect.height - height) / 2, globalThis.innerHeight - height - 8))}px`;
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
      if (previous === null) trigger.removeAttribute("aria-describedby");
      else trigger.setAttribute("aria-describedby", previous);
    };
  });
  function show() {
    setOpen(true);
  }
  return (
    <span
      ref={anchor}
      class="contents"
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onFocusIn={show}
      onFocusOut={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      {props.children}
      {open() ? (
        <Portal>
          <span
            ref={popup}
            id={id}
            role="tooltip"
            class={`fixed z-[140] max-w-[calc(100vw-16px)] rounded-[var(--rieul-radius-md)] bg-[var(--rieul-bg-inverse)] text-[var(--rieul-text-inverse)] px-[9px] py-[6px] text-[12px] font-650 pointer-events-none ${props.className ?? ""}`}
          >
            {props.label}
          </span>
        </Portal>
      ) : null}
    </span>
  );
}
