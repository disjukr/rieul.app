import { useBunja } from "bunja/react";
import { FileText } from "lucide-react";
import { displayName, formatSize } from "../../../../../../state/explorer.ts";
import { fileViewerBunja } from "./index.tsx";

interface FileOpenPromptProps {
  onCancel: () => void;
  onConfirm: () => void;
  viewerLabel: string;
}

export function FileOpenPrompt(
  { onCancel, onConfirm, viewerLabel }: FileOpenPromptProps,
) {
  const viewer = useBunja(fileViewerBunja);
  const fsEntry = viewer.fsEntry;
  const sizeLabel = fsEntry.size === undefined
    ? "Unknown size"
    : formatSize(fsEntry.size);

  return (
    <section className="file-open-prompt">
      <div className="file-open-prompt-panel">
        <div className="file-open-prompt-icon">
          <FileText size={24} />
        </div>
        <div className="file-open-prompt-copy">
          <h2>{displayName(fsEntry)}</h2>
          <p>
            This file is <strong>{sizeLabel}</strong>. Do you want to open it
            {" "}
            with the {viewerLabel}?
          </p>
          <p>{fsEntry.path}</p>
        </div>
        <div className="file-open-prompt-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm}>
            <FileText size={16} />
            Open
          </button>
        </div>
      </div>
    </section>
  );
}
