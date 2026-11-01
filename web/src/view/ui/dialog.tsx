import { className as joinClassName } from "../class-name.ts";

import { style, variants, theme } from "../../zyzz.config.ts";
import { Portal, type JSX } from "@solidjs/web";
import type { Props } from "zyzz";
import { createEffect } from "solid-js";
import { X } from "../../solid/icons.tsx";
import { IconButton } from "./icon-button.tsx";

const popupVariants = variants({
  base: {
    position: "fixed",
    left: "50%",
    top: "50%",
    zIndex: 101,
    maxHeight: "calc(100dvh - 48px)",
    width: "min(460px,calc(100vw - 48px))",
    transform:
      "translateX(-50%) translateY(-50%) translateZ(0) rotate(0) rotateX(0) rotateY(0) rotateZ(0) skewX(0) skewY(0) scaleX(1) scaleY(1) scaleZ(1)",
    overflow: "hidden",
    borderWidth: "1px",
    borderColor: theme.borderLight,
    borderRadius: theme.radiusLg,
    backgroundColor: theme.bgPrimary,
    boxShadow:
      "0 0 rgb(0 0 0 / 0), 0 0 rgb(0 0 0 / 0), var(--rieul-shadow-dialog)",
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  variants: {
    size: {
      md: {
        width: "min(460px,calc(100vw - 48px))",
      },
      sm: {
        width: "min(420px,calc(100vw - 48px))",
      },
    },
  },
  defaultVariants: {
    size: "md",
  },
});

export interface ModalDialogProps
  extends Omit<
    Props.Variants<typeof popupVariants>,
    "className" | "style" | "vars"
  > {
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
        {...popupVariants({
          size: props.size,
          className: joinClassName(
            styles.dialog().class ?? "",
            props.className ?? "",
          ),
        })}
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
        <header {...styles.header()}>
          <div>
            {props.eyebrow ? (
              <span {...styles.eyebrow()}>{props.eyebrow}</span>
            ) : null}
            <h2 id={props.titleId} {...styles.title()}>
              {props.title}
            </h2>
          </div>
          {props.showClose !== false ? (
            <IconButton
              disabled={props.closeDisabled}
              onClick={() => props.onClose()}
              title="Close"
              aria-label={props.closeLabel ?? "Close dialog"}
              className={styles.iconButton().class}
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

namespace styles {
  export const header = style({
    selectors: {
      "& div": {
        display: "grid",
        minWidth: "0",
        gap: "2px",
      },
    },
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    borderBottomWidth: "1px",
    borderBottomColor: theme.borderMuted,
    paddingLeft: "16px",
    paddingRight: "16px",
    paddingTop: "14px",
    paddingBottom: "14px",
  });
  export const eyebrow = style({
    fontSize: "12px",
    color: theme.textTertiary,
    fontWeight: 700,
  });
  export const title = style({
    margin: "0",
    fontSize: "18px",
    color: theme.textPrimary,
    fontWeight: 700,
    letterSpacing: "0",
  });
  export const iconButton = style({
    minWidth: "36px !important",
    width: "36px !important",
    padding: "0 !important",
  });
  export const dialog = style({
    margin: "0",
    selectors: {
      "&::backdrop": {
        backgroundColor: theme.overlayBackdrop,
      },
    },
    padding: "0",
  });
}
