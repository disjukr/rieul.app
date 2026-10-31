import { useContext } from "solid-js";
import { useAtomValue } from "../../../../../solid/jotai.tsx";
import { FilesExplorerContext, requireFilesExplorer } from "../context.tsx";
import { DirectoryContent } from "./directory/index.tsx";
import { FileViewer } from "./file-viewer/index.tsx";
import { FsEntryContext, FsEntryPathContext } from "./file-viewer/state.tsx";
import { TrashContent } from "./trash/index.tsx";
interface FilesContentProps {
  view: "browser" | "trash";
}
export function FilesContent(props: FilesContentProps) {
  const explorer = requireFilesExplorer(useContext(FilesExplorerContext));
  const openedFile = useAtomValue(() => explorer().openedFileAtom);
  return (
    <>
      {props.view === "trash" ? (
        <TrashContent />
      ) : openedFile() ? (
        <FsEntryPathContext value={() => openedFile()?.path}>
          <FsEntryContext value={() => openedFile()}>
            <FileViewer />
          </FsEntryContext>
        </FsEntryPathContext>
      ) : (
        <DirectoryContent />
      )}
    </>
  );
}
