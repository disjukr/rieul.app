import { useBunja } from "bunja/react";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { FileViewerFooter } from "./footer/index.tsx";
import { getFileViewerImpl } from "./impl/index.ts";
import { fileViewerBunja } from "./state.tsx";

export function FileViewer() {
  const viewer = useBunja(fileViewerBunja);
  const state = useAtomValue(viewer.stateAtom);
  const impl = useAtomValue(viewer.implAtom);
  const Impl = impl ? getFileViewerImpl(impl).Component : undefined;

  return (
    <section className="file-viewer">
      {state.phase === "detecting"
        ? (
          <div className="file-viewer-status">
            <Loader2 size={18} className="spin" />
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
