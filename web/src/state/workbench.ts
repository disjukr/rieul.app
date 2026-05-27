import { bunja } from "bunja";
import { atom } from "jotai";
import { createLayout, type LayoutState } from "panecake";
import { JotaiStoreScope } from "./jotai-store.ts";

export type WorkbenchFeature = "files" | "processes" | "terminal";
export type WorkbenchTool = "files";

export interface WorkbenchTab {
  id: string;
  title: string;
  tool: WorkbenchTool;
}

export interface WorkbenchPane {
  id: string;
  tabs: WorkbenchTab[];
  activeTabId: string;
}

const initialPaneId = "pane-1";
const initialTab = createFilesTab();

const initialLayout = createLayout((builder) => builder.leaf(initialPaneId));

export const workbenchBunja = bunja(() => {
  const store = bunja.use(JotaiStoreScope);

  const layoutAtom = atom<LayoutState>(initialLayout);
  const activeFeatureAtom = atom<WorkbenchFeature>("files");
  const panesAtom = atom<WorkbenchPane[]>([
    {
      id: initialPaneId,
      tabs: [initialTab],
      activeTabId: initialTab.id,
    },
  ]);

  function setLayout(layout: LayoutState) {
    store.set(layoutAtom, layout);
  }

  function selectFeature(feature: WorkbenchFeature) {
    store.set(activeFeatureAtom, feature);
  }

  function addPane(): string {
    const pane: WorkbenchPane = {
      id: `pane-${crypto.randomUUID()}`,
      tabs: [createFilesTab()],
      activeTabId: "",
    };
    pane.activeTabId = pane.tabs[0].id;
    store.set(panesAtom, (current) => [...current, pane]);
    return pane.id;
  }

  function removePane(paneId: string) {
    store.set(
      panesAtom,
      (current) =>
        current.length <= 1
          ? current
          : current.filter((pane) => pane.id !== paneId),
    );
  }

  function addFilesTab(paneId: string) {
    const tab = createFilesTab();
    store.set(
      panesAtom,
      (current) =>
        current.map((pane) =>
          pane.id === paneId
            ? {
              ...pane,
              tabs: [...pane.tabs, tab],
              activeTabId: tab.id,
            }
            : pane
        ),
    );
  }

  function selectTab(paneId: string, tabId: string) {
    store.set(
      panesAtom,
      (current) =>
        current.map((pane) =>
          pane.id === paneId ? { ...pane, activeTabId: tabId } : pane
        ),
    );
  }

  function closeTab(paneId: string, tabId: string) {
    store.set(
      panesAtom,
      (current) =>
        current.map((pane) => {
          if (pane.id !== paneId || pane.tabs.length <= 1) return pane;
          const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
          const activeTabId = pane.activeTabId === tabId
            ? tabs[0].id
            : pane.activeTabId;
          return { ...pane, tabs, activeTabId };
        }),
    );
  }

  return {
    layoutAtom,
    activeFeatureAtom,
    panesAtom,
    setLayout,
    selectFeature,
    addPane,
    removePane,
    addFilesTab,
    selectTab,
    closeTab,
  };
});

function createFilesTab(): WorkbenchTab {
  return {
    id: `files-${crypto.randomUUID()}`,
    title: "Files",
    tool: "files",
  };
}
