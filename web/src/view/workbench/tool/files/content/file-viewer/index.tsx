import { Dynamic } from "@solidjs/web";
import { createMemo, Loading } from "solid-js";
import { useBunja } from "../../../../../../solid/bunja.tsx";
import { useAtomValue } from "../../../../../../solid/jotai.tsx";
import { Loader2 } from "../../../../../../solid/icons.tsx";
import { FileViewerFooter } from "./footer/index.tsx";
import { getFileViewerImpl } from "./impl/index.ts";
import { fileViewerBunja } from "./state.tsx";
const fileViewerStatusClassName = [
  "flex items-center justify-center gap-[8px] min-w-0 min-h-0",
  "text-[#667085] text-[14px]",
  "[&.error]:items-start [&.error]:justify-start [&.error]:overflow-auto",
  "[&.error]:text-[#b42318] [&.error]:p-[14px]",
].join(" ");
const fileViewerClassName = [
  "grid [grid-template-rows:minmax(0,1fr)_auto]",
  "w-full h-full min-w-0 min-h-0 overflow-hidden bg-white",
].join(" ");
export function FileViewer() {
  const viewer = useBunja(fileViewerBunja);
  const state = useAtomValue(() => viewer().stateAtom);
  const impl = useAtomValue(() => viewer().implAtom);
  const Impl = createMemo(() => {
    const value = impl();
    return value ? getFileViewerImpl(value).Component : undefined;
  });
  const errorMessage = createMemo(() => {
    const value = state();
    return value.phase === "error" ? value.message : "";
  });
  return (
    <section class={fileViewerClassName}>
      {state().phase === "detecting" ? (
        <div class={fileViewerStatusClassName}>
          <Loader2 size={18} className="animate-spin" />
          <span>Detecting viewer</span>
        </div>
      ) : state().phase === "error" ? (
        <div role="alert" class={`${fileViewerStatusClassName} error`}>
          {errorMessage()}
        </div>
      ) : Impl() ? (
        <Loading
          fallback={
            <div class={fileViewerStatusClassName}>
              <Loader2 size={18} className="animate-spin" />
              <span>Loading viewer</span>
            </div>
          }
        >
          <Dynamic component={Impl()} />
        </Loading>
      ) : null}
      <FileViewerFooter />
    </section>
  );
}
