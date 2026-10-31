import { Portal, type JSX } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { createEffect } from "solid-js";
import { X } from "../../solid/icons.tsx";
import { className as joinClassName } from "../class-name.ts";
import { IconButton } from "./icon-button.tsx";

const popupVariants = cva(
  [
    "fixed left-1/2 top-1/2 z-[101] max-h-[calc(100dvh-48px)]",
    "w-[min(460px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2",
    "overflow-hidden",
    "border border-[var(--rieul-border-light)] rounded-[var(--rieul-radius-lg)]",
    "bg-[var(--rieul-bg-primary)] shadow-rieul-dialog outline-none",
  ],
  {
    variants: {
      size: {
        md: "w-[min(460px,calc(100vw-48px))]",
        sm: "w-[min(420px,calc(100vw-48px))]",
      },
    },
    defaultVariants: {
      size: "md",
    },
  },
);

const headerClassName = [
  "flex items-center justify-between gap-[12px]",
  "border-b border-b-[var(--rieul-border-muted)] px-[16px] py-[14px]",
  "[&_div]:grid [&_div]:min-w-0 [&_div]:gap-[2px]",
].join(" ");
const eyebrowClassName =
  "text-[12px] font-700 text-[var(--rieul-text-tertiary)]";
const titleClassName =
  "m-0 text-[18px] font-700 tracking-[0] text-[var(--rieul-text-primary)]";
const iconButtonClassName = "!w-[36px] !min-w-[36px] !p-0";

export interface ModalDialogProps extends VariantProps<typeof popupVariants> {
  bodyClassName?: string;
  children: JSX.Element;
  className?: string;
  closeDisabled?: boolean;
  closeLabel?: string;
  disablePointerDismissal?: boolean;
  eyebrow?: JSX.Element;
  showClose?: boolean;
  title: JSX.Element;
  titleId: string;
  onClose: () => void;
}

export function ModalDialog(props: ModalDialogProps) {
  let dialog!: HTMLDialogElement;
  createEffect(
    () => true,
    () => {
      const previous = document.activeElement;
      dialog.showModal();
      return () => {
        dialog.close();
        if (previous instanceof HTMLElement && previous.isConnected)
          previous.focus();
      };
    },
  );
  return (
    <Portal>
      <dialog
        ref={dialog}
        aria-labelledby={props.titleId}
        class={joinClassName(
          popupVariants({ size: props.size }),
          "m-0 p-0 [&::backdrop]:bg-[var(--rieul-overlay-backdrop)]",
          props.className,
        )}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [
            ...dialog.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
            ),
          ].filter(
            (element) =>
              !element.closest("[hidden], [inert]") &&
              element.getClientRects().length > 0,
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first) {
            event.preventDefault();
            dialog.focus();
          } else if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === dialog)
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          if (!props.closeDisabled) props.onClose();
        }}
        onClick={(event) => {
          if (
            event.target === dialog &&
            !props.disablePointerDismissal &&
            !props.closeDisabled
          ) {
            const rect = dialog.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              props.onClose();
          }
        }}
      >
        <header class={headerClassName}>
          <div>
            {props.eyebrow ? (
              <span class={eyebrowClassName}>{props.eyebrow}</span>
            ) : null}
            <h2 id={props.titleId} class={titleClassName}>
              {props.title}
            </h2>
          </div>
          {props.showClose !== false ? (
            <IconButton
              disabled={props.closeDisabled}
              onClick={() => props.onClose()}
              title="Close"
              aria-label={props.closeLabel ?? "Close dialog"}
              className={iconButtonClassName}
            >
              <X size={16} />
            </IconButton>
          ) : null}
        </header>
        <div class={props.bodyClassName}>{props.children}</div>
      </dialog>
    </Portal>
  );
}
