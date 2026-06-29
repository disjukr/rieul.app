import { FileQuestion, FileText, Folder, HardDrive, Link2 } from "lucide-react";
import {
  type FsEntry,
  FsEntryKind,
} from "../../../../../../protocol/generated/rpc.ts";

interface EntryIconProps {
  entry: FsEntry;
}

export function EntryIcon({ entry }: EntryIconProps) {
  if (entry.kind === FsEntryKind.Directory) {
    return entry.path.endsWith("\\")
      ? <HardDrive size={12} />
      : <Folder size={12} />;
  }
  if (entry.kind === FsEntryKind.Symlink) return <Link2 size={12} />;
  if (entry.kind === FsEntryKind.File) return <FileText size={12} />;
  return <FileQuestion size={12} />;
}
