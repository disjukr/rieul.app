import { Activity, Folder, Terminal } from "lucide-react";
import type { WorkbenchFeature } from "../../state/workbench.ts";

const features: {
  id: WorkbenchFeature;
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

interface FeatureMenuProps {
  activeFeature: WorkbenchFeature;
  onSelect: (feature: WorkbenchFeature) => void;
}

export function FeatureMenu(
  { activeFeature, onSelect }: FeatureMenuProps,
) {
  return (
    <nav className="feature-menu" aria-label="Workspace features">
      {features.map(({ id, label, disabled, Icon }) => (
        <button
          type="button"
          key={id}
          className={activeFeature === id
            ? "feature-item active"
            : "feature-item"}
          onClick={() => onSelect(id)}
          disabled={disabled}
          aria-current={activeFeature === id ? "page" : undefined}
        >
          <Icon size={17} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
