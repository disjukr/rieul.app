import type { FsEntry } from "../../../../../../protocol/generated/rpc.ts";
import {
  displayName,
  formatDate,
  formatSize,
  kindLabel,
} from "../../../../../../state/explorer.ts";
import { ModalDialog } from "../../../../../ui/dialog.tsx";

const inspectorClassName = [
  "inspector min-w-0 overflow-auto border-l border-l-[var(--wgo-border-light)]",
  "[@container_workbench-tab-page_(max-width:980px)]:hidden",
  "bg-[var(--wgo-bg-subtle)] p-[14px]",
  "[&_dl]:grid [&_dl]:gap-[6px] [&_dl]:m-0",
  "[&_dt]:text-[var(--wgo-text-tertiary)] [&_dt]:text-[12px] [&_dt]:font-700",
  "[&_dd]:min-w-0 [&_dd]:mt-0 [&_dd]:mx-0 [&_dd]:mb-[8px]",
  "[&_dd]:[overflow-wrap:anywhere] [&_dd]:text-[var(--wgo-text-strong)] [&_dd]:text-[13px]",
].join(" ");
const inspectorTitleClassName =
  "mb-[12px] text-[var(--wgo-text-primary)] font-700";
const entryPropertiesBodyClassName = [
  "pt-[14px] px-[16px] pb-[16px]",
  "[&_dl]:grid [&_dl]:gap-[6px] [&_dl]:m-0",
  "[&_dt]:text-[var(--wgo-text-tertiary)] [&_dt]:text-[12px] [&_dt]:font-700",
  "[&_dd]:min-w-0 [&_dd]:mt-0 [&_dd]:mx-0 [&_dd]:mb-[8px]",
  "[&_dd]:[overflow-wrap:anywhere] [&_dd]:text-[var(--wgo-text-strong)] [&_dd]:text-[13px]",
].join(" ");

interface InspectorProps {
  entry?: FsEntry;
  currentPath?: string;
}

interface EntryPropertiesModalProps {
  entry: FsEntry;
  onClose: () => void;
}

interface EntryDetailsProps {
  entry?: FsEntry;
  currentPath?: string;
}

export function Inspector(
  { entry, currentPath }: InspectorProps,
) {
  return (
    <aside className={inspectorClassName}>
      <div className={inspectorTitleClassName}>Selection</div>
      <EntryDetails entry={entry} currentPath={currentPath} />
    </aside>
  );
}

export function EntryPropertiesModal(
  { entry, onClose }: EntryPropertiesModalProps,
) {
  return (
    <ModalDialog
      eyebrow="File"
      title="Properties"
      titleId="entry-properties-title"
      bodyClassName={entryPropertiesBodyClassName}
      closeLabel="Close properties modal"
      onClose={onClose}
    >
      <EntryDetails entry={entry} />
    </ModalDialog>
  );
}

function EntryDetails(
  { entry, currentPath }: EntryDetailsProps,
) {
  if (!entry) {
    return (
      <dl>
        <dt>Location</dt>
        <dd>{currentPath ?? "Files"}</dd>
      </dl>
    );
  }

  return (
    <dl>
      <dt>Name</dt>
      <dd>{displayName(entry)}</dd>
      <dt>Path</dt>
      <dd>{entry.path}</dd>
      <dt>Kind</dt>
      <dd>{kindLabel(entry.kind)}</dd>
      <dt>Size</dt>
      <dd>{formatSize(entry.size)}</dd>
      <dt>Modified</dt>
      <dd>{formatDate(entry.modifiedAtMs)}</dd>
      <dt>Flags</dt>
      <dd>{entry.readonly ? "Readonly" : "Writable"}</dd>
    </dl>
  );
}
