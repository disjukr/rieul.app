import { Portal, type JSX } from "@solidjs/web";
import { createEffect, createSignal, createUniqueId } from "solid-js";
interface AppTooltipProps {
  children: JSX.Element;
  className?: string;
  label: JSX.Element;
}
export function AppTooltip(props: AppTooltipProps) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ left: 0, top: 0 });
  const id = createUniqueId();
  let anchor!: HTMLSpanElement;
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
    return () => {
      if (previous === null) trigger.removeAttribute("aria-describedby");
      else trigger.setAttribute("aria-describedby", previous);
    };
  });
  function show() {
    const rect = (anchor.firstElementChild ?? anchor).getBoundingClientRect();
    setPosition({ left: rect.right + 12, top: rect.top + rect.height / 2 });
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
            id={id}
            role="tooltip"
            class={`fixed z-[140] -translate-y-1/2 rounded-[var(--rieul-radius-md)] bg-[var(--rieul-bg-inverse)] text-[var(--rieul-text-inverse)] px-[9px] py-[6px] text-[12px] font-650 pointer-events-none ${props.className ?? ""}`}
            style={{ left: `${position().left}px`, top: `${position().top}px` }}
          >
            {props.label}
          </span>
        </Portal>
      ) : null}
    </span>
  );
}
