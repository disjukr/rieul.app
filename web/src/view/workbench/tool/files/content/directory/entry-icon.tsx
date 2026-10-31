import {
  FileQuestion,
  FileText,
  Folder,
  HardDrive,
  Link2,
} from "../../../../../../solid/icons.tsx";
import {
  type FsEntry,
  FsEntryKind,
} from "../../../../../../protocol/generated/rpc.ts";
interface EntryIconProps {
  entry: FsEntry;
}
export function EntryIcon(props: EntryIconProps) {
  return (
    <>
      {props.entry.kind === FsEntryKind.Directory ? (
        props.entry.path.endsWith("\\") ? (
          <HardDrive size={12} />
        ) : (
          <Folder size={12} />
        )
      ) : props.entry.kind === FsEntryKind.Symlink ? (
        <Link2 size={12} />
      ) : props.entry.kind === FsEntryKind.File ? (
        <FileText size={12} />
      ) : (
        <FileQuestion size={12} />
      )}
    </>
  );
}
