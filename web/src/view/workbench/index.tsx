import { bunja } from "bunja";
import { atom, useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import { ChevronLeft } from "lucide-react";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { MachineAddFormContainer } from "../machine-panel/index.tsx";
import { WorkbenchPaneLayout } from "./pane-layout/index.tsx";
import { type MouseEvent, PropsWithChildren } from "react";
import { className } from "../class-name.ts";

const workbenchClassName = [
  "workbench [grid-column:2] [grid-row:1]",
  "m-0 min-w-0 min-h-0 overflow-visible",
  "bg-transparent shadow-none",
  "max-[680px]:[grid-column:2] max-[680px]:[grid-row:1] max-[680px]:m-0",
  "max-[680px]:bg-rieul-canvas",
  "max-[680px]:grid max-[680px]:[grid-template-rows:44px_minmax(0,1fr)] max-[680px]:overflow-hidden",
  "max-[680px]:[scroll-snap-align:start] max-[680px]:[scroll-snap-stop:always]",
].join(" ");
const mobileWorkbenchHeaderClassName = [
  "hidden min-w-0 items-center gap-[8px] border-b border-b-rieul-border",
  "bg-[rgba(248,248,248,0.86)] px-[8px] backdrop-blur-2xl",
  "max-[680px]:flex",
].join(" ");
const mobileBackButtonClassName = [
  "inline-flex h-[34px] w-[34px] min-w-[34px] appearance-none items-center justify-center",
  "rounded-[12px] border border-transparent bg-transparent p-0 text-rieul-text-2",
  "[font-family:inherit] cursor-pointer rieul-transition",
  "hover:border-white/48 hover:bg-white/42 hover:text-rieul-text",
  "active:bg-rieul-active",
].join(" ");
const mobileMachineTitleClassName = [
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
  "text-[13px] font-760 text-rieul-text",
].join(" ");
const inlineMachineSetupClassName = [
  "grid content-center justify-items-center min-h-0 overflow-auto p-[24px]",
].join(" ");
const inlineMachineCardClassName = [
  "w-[min(460px,100%)] overflow-hidden border border-[var(--rieul-border-light)]",
  "rounded-[8px] bg-[var(--rieul-bg-primary)]",
].join(" ");
const modalHeadClassName = [
  "flex items-center justify-between gap-[12px] border-b border-b-[var(--rieul-border-muted)]",
  "px-[16px] py-[14px]",
  "[&_div]:grid [&_div]:gap-[2px] [&_div]:min-w-0",
  "[&_span]:text-[var(--rieul-text-tertiary)] [&_span]:text-[12px] [&_span]:font-700",
  "[&_h2]:m-0 [&_h2]:text-[var(--rieul-text-primary)] [&_h2]:text-[18px] [&_h2]:tracking-[0]",
].join(" ");

const workbenchRegionBunja = bunja(() => {
  const { machinesAtom, selectedAtom } = bunja.use(machineStoreBunja);
  const hasMachinesAtom = atom((get) => get(machinesAtom).length > 0);
  return { hasMachinesAtom, selectedAtom };
});

export function WorkbenchRegion() {
  const { hasMachinesAtom, selectedAtom } = useBunja(workbenchRegionBunja);
  const hasMachines = useAtomValue(hasMachinesAtom);
  const selected = useAtomValue(selectedAtom);
  return (
    <section
      className={className(workbenchClassName, !hasMachines && "grid")}
    >
      <MobileWorkbenchHeader machineName={selected?.name ?? "No machine"} />
      {hasMachines ? <WorkbenchPaneLayout /> : (
        <InlineMachineSetup>
          <MachineAddFormContainer showCancel={false} />
        </InlineMachineSetup>
      )}
    </section>
  );
}

function MobileWorkbenchHeader({ machineName }: { machineName: string }) {
  return (
    <header className={mobileWorkbenchHeaderClassName}>
      <button
        type="button"
        className={mobileBackButtonClassName}
        onClick={showMobileRail}
        aria-label="Back to app rail"
        title="Back"
      >
        <ChevronLeft size={20} strokeWidth={2.2} />
      </button>
      <div className={mobileMachineTitleClassName}>{machineName}</div>
    </header>
  );
}

function showMobileRail(event: MouseEvent<HTMLButtonElement>) {
  const shell = event.currentTarget.closest<HTMLElement>(".app-shell") ??
    document.querySelector<HTMLElement>(".app-shell");
  if (!shell) return;
  shell.scrollTo({ left: 0, behavior: "smooth" });
}

function InlineMachineSetup({ children }: PropsWithChildren) {
  return (
    <section className={inlineMachineSetupClassName}>
      <div className={inlineMachineCardClassName}>
        <header className={modalHeadClassName}>
          <div>
            <span>Machine</span>
            <h2>Add machine</h2>
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}
