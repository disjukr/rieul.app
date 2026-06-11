import { useBunja } from "bunja/react";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { FileViewerFooter } from "./footer/index.tsx";
import { getFileViewerImpl } from "./impl/index.ts";
import { fileViewerBunja } from "./state.tsx";

const fileViewerStatusClassName = [
  "flex items-center justify-center gap-[8px] min-w-0 min-h-0",
  "text-[#667085] text-[13px]",
  "[&.error]:items-start [&.error]:justify-start [&.error]:overflow-auto",
  "[&.error]:text-[#b42318] [&.error]:p-[14px]",
].join(" ");

const fileViewerClassName = [
  "grid [grid-template-rows:minmax(0,1fr)_auto]",
  "w-full h-full min-w-0 min-h-0 overflow-hidden bg-white",
].join(" ");

export function FileViewer() {
  const viewer = useBunja(fileViewerBunja);
  const state = useAtomValue(viewer.stateAtom);
  const impl = useAtomValue(viewer.implAtom);
  const Impl = impl ? getFileViewerImpl(impl).Component : undefined;

  return (
    <section className={fileViewerClassName}>
      {state.phase === "detecting"
        ? (
          <div className={fileViewerStatusClassName}>
            <Loader2 size={18} className="animate-spin" />
            <span>Detecting viewer</span>
          </div>
        )
        : Impl
        ? <Impl />
        : null}
      <FileViewerFooter />
    </section>
  );
}
