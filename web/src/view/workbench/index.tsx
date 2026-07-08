import { bunja } from "bunja";
import { atom, useAtomValue } from "jotai";
import { useBunja } from "bunja/react";
import {
  Activity,
  Braces,
  CircleDot,
  Command,
  FolderTree,
  Monitor,
  Terminal,
} from "lucide-react";
import { machineStoreBunja } from "../../state/machine-store.ts";
import { MachineAddFormContainer } from "../machine-panel/index.tsx";
import { WorkbenchPaneLayout } from "./pane-layout/index.tsx";
import { PropsWithChildren } from "react";
import { className } from "../class-name.ts";

const workbenchClassName = [
  "workbench [grid-column:3] [grid-row:1]",
  "m-0 min-w-0 min-h-0 overflow-visible",
  "bg-transparent shadow-none",
  "max-[680px]:[grid-column:1] max-[680px]:[grid-row:1] max-[680px]:m-0",
].join(" ");
const inlineMachineSetupClassName = [
  "relative grid min-h-0 overflow-auto bg-wgo-surface",
].join(" ");
const inlineMachineContentClassName = [
  "grid min-h-full w-full content-start gap-[18px] p-[22px]",
  "[grid-template-columns:minmax(320px,0.8fr)_minmax(360px,440px)]",
  "max-[1120px]:[grid-template-columns:minmax(0,1fr)] max-[1120px]:content-start",
  "max-[680px]:gap-[18px] max-[680px]:p-[16px]",
].join(" ");
const introPanelClassName = [
  "grid content-start gap-[14px] min-w-0",
  "max-[1120px]:content-start max-[680px]:gap-[14px]",
].join(" ");
const introKickerClassName = [
  "inline-flex w-fit items-center gap-[8px] rounded-wgo-lg border border-wgo-border",
  "bg-white/76 px-[10px] py-[6px] text-[13px] font-650 text-wgo-text-2 shadow-wgo-sm",
].join(" ");
const introTitleClassName = [
  "m-0 max-w-[520px] text-[24px] font-750 leading-[1.16] tracking-[0]",
  "text-wgo-text max-[680px]:text-[22px]",
].join(" ");
const introCopyClassName = [
  "m-0 max-w-[520px] text-[14px] leading-[1.5] text-wgo-text-2",
].join(" ");
const signalGridClassName = [
  "grid max-w-[680px] gap-[10px]",
  "[grid-template-columns:repeat(2,minmax(0,1fr))]",
  "max-[680px]:hidden",
].join(" ");
const signalCardClassName = [
  "grid gap-[8px] rounded-wgo-lg border border-wgo-border bg-white/82 p-[10px]",
  "shadow-wgo-sm backdrop-blur",
].join(" ");
const signalIconClassName = [
  "flex h-[28px] w-[28px] items-center justify-center rounded-wgo-lg",
  "border border-wgo-border bg-wgo-surface-2 text-wgo-text-2",
].join(" ");
const signalTitleClassName = "text-[14px] font-700 leading-none text-wgo-text";
const signalMetaClassName = "text-[13px] leading-[1.45] text-wgo-text-3";
const commandPanelClassName = [
  "max-w-[680px] rounded-wgo-xl border border-white/10 bg-[rgba(13,17,23,0.96)]",
  "p-[10px] shadow-wgo-lg",
  "max-[680px]:hidden",
].join(" ");
const commandSearchClassName = [
  "flex items-center gap-[10px] rounded-wgo-xl border border-white/8",
  "bg-white/7 px-[13px] py-[12px] text-[14px] text-wgo-chrome-text",
].join(" ");
const commandListClassName = "mt-[8px] grid gap-[4px]";
const commandRowClassName = [
  "grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-[10px]",
  "rounded-wgo-lg px-[8px] py-[8px] text-wgo-chrome-text",
].join(" ");
const commandRowMutedClassName = "text-wgo-chrome-subtle";
const commandRowActiveClassName = "bg-white/10";
const commandIconClassName = [
  "flex h-[24px] w-[24px] items-center justify-center rounded-wgo-md bg-white/10",
].join(" ");
const commandNameClassName = "text-[13px] font-650";
const commandTagClassName = "text-[12px] text-wgo-chrome-subtle";
const inlineMachineCardClassName = [
  "self-start overflow-hidden border border-wgo-border",
  "rounded-wgo-xl bg-wgo-surface shadow-wgo-lg",
  "max-[1120px]:w-[min(480px,100%)] max-[680px]:w-full max-[680px]:self-start",
].join(" ");
const modalHeadClassName = [
  "flex items-center justify-between gap-[12px] border-b border-b-wgo-border",
  "bg-wgo-surface-2 px-[18px] py-[15px]",
  "[&_div]:grid [&_div]:gap-[2px] [&_div]:min-w-0",
  "[&_span]:text-wgo-text-3 [&_span]:text-[13px] [&_span]:font-600",
  "[&_h2]:m-0 [&_h2]:text-wgo-text [&_h2]:text-[19px] [&_h2]:tracking-[0]",
].join(" ");

const workbenchRegionBunja = bunja(() => {
  const { machinesAtom } = bunja.use(machineStoreBunja);
  const hasMachinesAtom = atom((get) => get(machinesAtom).length > 0);
  return { hasMachinesAtom };
});

export function WorkbenchRegion() {
  const { hasMachinesAtom } = useBunja(workbenchRegionBunja);
  const hasMachines = useAtomValue(hasMachinesAtom);
  return (
    <section
      className={className(workbenchClassName, !hasMachines && "grid")}
    >
      {hasMachines ? <WorkbenchPaneLayout /> : (
        <InlineMachineSetup>
          <MachineAddFormContainer showCancel={false} />
        </InlineMachineSetup>
      )}
    </section>
  );
}

function InlineMachineSetup({ children }: PropsWithChildren) {
  return (
    <section className={inlineMachineSetupClassName}>
      <div className={inlineMachineContentClassName}>
        <div className={introPanelClassName}>
          <div className={introKickerClassName}>
            <CircleDot size={14} />
            <span>Local workspace</span>
          </div>
          <div>
            <h2 className={introTitleClassName}>Connect a machine.</h2>
            <p className={introCopyClassName}>
              No active target.
            </p>
          </div>
          <div className={signalGridClassName} aria-label="Workspace surfaces">
            <SignalCard
              icon={<FolderTree size={15} />}
              title="Files"
              meta="Workspace"
            />
            <SignalCard
              icon={<Terminal size={15} />}
              title="Terminal"
              meta="Shell"
            />
            <SignalCard
              icon={<Monitor size={15} />}
              title="Windows"
              meta="Desktop"
            />
            <SignalCard
              icon={<Activity size={15} />}
              title="Processes"
              meta="Runtime"
            />
          </div>
          <CommandPreview />
        </div>
        <div className={inlineMachineCardClassName}>
          <header className={modalHeadClassName}>
            <div>
              <span>Machine</span>
              <h2>Add machine</h2>
            </div>
          </header>
          {children}
        </div>
      </div>
    </section>
  );
}

interface SignalCardProps {
  icon: React.ReactNode;
  meta: string;
  title: string;
}

function SignalCard({ icon, meta, title }: SignalCardProps) {
  return (
    <div className={signalCardClassName}>
      <div className={signalIconClassName}>{icon}</div>
      <div>
        <div className={signalTitleClassName}>{title}</div>
        <div className={signalMetaClassName}>{meta}</div>
      </div>
    </div>
  );
}

function CommandPreview() {
  return (
    <div className={commandPanelClassName} aria-label="Workspace command list">
      <div className={commandSearchClassName}>
        <Command size={15} />
        <span>Workspace command</span>
      </div>
      <div className={commandListClassName}>
        <CommandRow
          active
          icon={<Braces size={14} />}
          name="Pair local daemon"
          tag="setup"
        />
        <CommandRow
          icon={<FolderTree size={14} />}
          name="Open files"
          tag="files"
        />
        <CommandRow
          icon={<Terminal size={14} />}
          name="Start shell"
          tag="terminal"
        />
      </div>
    </div>
  );
}

interface CommandRowProps {
  active?: boolean;
  icon: React.ReactNode;
  name: string;
  tag: string;
}

function CommandRow({ active, icon, name, tag }: CommandRowProps) {
  return (
    <div
      className={className(
        commandRowClassName,
        active ? commandRowActiveClassName : commandRowMutedClassName,
      )}
    >
      <span className={commandIconClassName}>{icon}</span>
      <span className={commandNameClassName}>{name}</span>
      <span className={commandTagClassName}>{tag}</span>
    </div>
  );
}
