import { useContext } from "react";
import { useAtomValue } from "jotai";
import { FilesExplorerContext, requireFilesExplorer } from "../context.tsx";
import { DirectoryContent } from "./directory/index.tsx";
import { FileViewer } from "./file-viewer/index.tsx";
import { FsEntryContext, FsEntryPathContext } from "./file-viewer/state.tsx";
import { TrashContent } from "./trash/index.tsx";

interface FilesContentProps {
  view: "browser" | "trash";
}

export function FilesContent({ view }: FilesContentProps) {
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const openedFile = useAtomValue(explorer.openedFileAtom);

  if (view === "trash") return <TrashContent />;

  if (openedFile) {
    return (
      <FsEntryPathContext value={openedFile.path}>
        <FsEntryContext value={openedFile}>
          <FileViewer />
        </FsEntryContext>
      </FsEntryPathContext>
    );
  }

  return <DirectoryContent />;
}
