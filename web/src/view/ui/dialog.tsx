import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { className as joinClassName } from "../class-name.ts";
import { IconButton } from "./icon-button.tsx";

const backdropVariants = cva(
  "fixed inset-0 z-[100] bg-[var(--rieul-overlay-backdrop)]",
);

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
const eyebrowClassName = "text-[12px] font-700 text-[var(--rieul-text-tertiary)]";
const titleClassName =
  "m-0 text-[18px] font-700 tracking-[0] text-[var(--rieul-text-primary)]";
const iconButtonClassName = "!w-[36px] !min-w-[36px] !p-0";

export interface ModalDialogProps extends VariantProps<typeof popupVariants> {
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  closeDisabled?: boolean;
  closeLabel?: string;
  disablePointerDismissal?: boolean;
  eyebrow?: ReactNode;
  showClose?: boolean;
  title: ReactNode;
  titleId: string;
  onClose: () => void;
}

export function ModalDialog(
  {
    bodyClassName,
    children,
    className,
    closeDisabled = false,
    closeLabel = "Close dialog",
    disablePointerDismissal = false,
    eyebrow,
    showClose = true,
    size,
    title,
    titleId,
    onClose,
  }: ModalDialogProps,
) {
  return (
    <Dialog.Root
      open
      disablePointerDismissal={disablePointerDismissal}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={backdropVariants()} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={joinClassName(popupVariants({ size }), className)}
        >
          <header className={headerClassName}>
            <div>
              {eyebrow
                ? <span className={eyebrowClassName}>{eyebrow}</span>
                : null}
              <Dialog.Title id={titleId} className={titleClassName}>
                {title}
              </Dialog.Title>
            </div>
            {showClose
              ? (
                <Dialog.Close
                  disabled={closeDisabled}
                  render={
                    <IconButton
                      title="Close"
                      aria-label={closeLabel}
                      className={iconButtonClassName}
                    >
                      <X size={16} />
                    </IconButton>
                  }
                />
              )
              : null}
          </header>
          <div className={bodyClassName}>{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
