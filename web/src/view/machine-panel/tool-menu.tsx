import { Activity, Folder, Terminal } from "lucide-react";
import type { WorkbenchTool } from "../../state/workbench.ts";
import { className } from "../class-name.ts";

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

const toolMenuClassName =
  "grid content-start gap-[4px] min-h-0 overflow-auto px-[8px] py-[10px]";
const toolItemClassName = [
  "justify-start w-full min-h-[38px] border-0 rounded-[6px]",
  "bg-transparent text-[#475467] px-[10px] text-left",
  "hover:bg-[#eef3fb] hover:text-[#20242d]",
  "[&.active]:bg-[#eef3fb] [&.active]:text-[#20242d]",
  "disabled:opacity-56",
  "[&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis",
  "[&_span]:whitespace-nowrap [&_span]:text-[13px] [&_span]:font-700",
].join(" ");

interface ToolMenuProps {
  activeTool: WorkbenchTool;
  onSelect: (tool: WorkbenchTool) => void;
}

export function ToolMenu(
  { activeTool, onSelect }: ToolMenuProps,
) {
  return (
    <nav className={toolMenuClassName} aria-label="Workspace tools">
      {tools.map(({ id, label, disabled, Icon }) => (
        <button
          type="button"
          key={id}
          className={className(
            toolItemClassName,
            activeTool === id && "active",
          )}
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
