import { Activity, Folder, Terminal } from "lucide-react";
import type { WorkbenchTool } from "../../state/workbench.ts";

const tools: {
  id: WorkbenchTool;
  label: string;
  disabled?: boolean;
  Icon: typeof Folder;
}[] = [
  {
    id: "files",
    label: "Files",
    Icon: Folder,
  },
  {
    id: "processes",
    label: "Processes",
    Icon: Activity,
    disabled: true,
  },
  {
    id: "terminal",
    label: "Terminal",
    Icon: Terminal,
    disabled: true,
  },
];

interface ToolMenuProps {
  activeTool: WorkbenchTool;
  onSelect: (tool: WorkbenchTool) => void;
}

export function ToolMenu(
  { activeTool, onSelect }: ToolMenuProps,
) {
  return (
    <nav className="tool-menu" aria-label="Workspace tools">
      {tools.map(({ id, label, disabled, Icon }) => (
        <button
          type="button"
          key={id}
          className={activeTool === id ? "tool-item active" : "tool-item"}
          onClick={() => onSelect(id)}
          disabled={disabled}
          aria-current={activeTool === id ? "page" : undefined}
        >
          <Icon size={17} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
