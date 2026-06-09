import { bunja, createScope } from "bunja";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
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

interface WorkbenchState {
  layout: LayoutState;
  activeFeature: WorkbenchFeature;
  panes: WorkbenchPane[];
}

export type TabDropPosition = "before" | "after" | "end";

export const WorkbenchMachineScope = createScope<string | undefined>();

export const workbenchBunja = bunja(() => {
  const machineId = bunja.use(WorkbenchMachineScope);
  const store = bunja.use(JotaiStoreScope);
  const initialPaneId = `pane-${crypto.randomUUID()}`;
  const initialTab = createFilesTab();
  const initialLayout = createLayout((builder) => builder.leaf(initialPaneId));
  const initialState: WorkbenchState = {
    layout: initialLayout,
    activeFeature: "files",
    panes: [
      {
        id: initialPaneId,
        tabs: [initialTab],
        activeTabId: initialTab.id,
      },
    ],
  };
  const stateAtom = atomWithStorage<WorkbenchState>(
    workbenchStorageKey(machineId),
    initialState,
    undefined,
    { getOnInit: true },
  );
  const layoutAtom = atom((get) => get(stateAtom).layout);
  const activeFeatureAtom = atom((get) => get(stateAtom).activeFeature);
  const panesAtom = atom((get) => get(stateAtom).panes);

  function setLayout(layout: LayoutState) {
    store.set(stateAtom, (current) => ({ ...current, layout }));
  }

  function selectFeature(feature: WorkbenchFeature) {
    store.set(stateAtom, (current) => ({ ...current, activeFeature: feature }));
  }

  function addPane(): string {
    const pane: WorkbenchPane = {
      id: `pane-${crypto.randomUUID()}`,
      tabs: [createFilesTab()],
      activeTabId: "",
    };
    pane.activeTabId = pane.tabs[0].id;
    store.set(stateAtom, (current) => ({
      ...current,
      panes: [...current.panes, pane],
    }));
    return pane.id;
  }

  function removePane(paneId: string) {
    store.set(
      stateAtom,
      (current) => ({
        ...current,
        panes: current.panes.length <= 1
          ? current.panes
          : current.panes.filter((pane) => pane.id !== paneId),
      }),
    );
  }

  function updatePanes(update: (panes: WorkbenchPane[]) => WorkbenchPane[]) {
    store.set(
      stateAtom,
      (current) => ({
        ...current,
        panes: update(current.panes),
      }),
    );
  }

  function addFilesTab(paneId: string) {
    const tab = createFilesTab();
    updatePanes((current) =>
      current.map((pane) =>
        pane.id === paneId
          ? {
            ...pane,
            tabs: [...pane.tabs, tab],
            activeTabId: tab.id,
          }
          : pane
      )
    );
  }

  function selectTab(paneId: string, tabId: string) {
    updatePanes((current) =>
      current.map((pane) =>
        pane.id === paneId ? { ...pane, activeTabId: tabId } : pane
      )
    );
  }

  function closeTab(paneId: string, tabId: string) {
    updatePanes((current) =>
      current.map((pane) => {
        if (pane.id !== paneId || pane.tabs.length <= 1) return pane;
        const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
        const activeTabId = pane.activeTabId === tabId
          ? tabs[0].id
          : pane.activeTabId;
        return { ...pane, tabs, activeTabId };
      })
    );
  }

  function moveTab(
    sourcePaneId: string,
    tabId: string,
    targetPaneId: string,
    targetTabId: string | undefined,
    position: TabDropPosition,
  ) {
    updatePanes((current) => {
      const sourcePane = current.find((pane) => pane.id === sourcePaneId);
      const targetPane = current.find((pane) => pane.id === targetPaneId);
      const movingTab = sourcePane?.tabs.find((tab) => tab.id === tabId);
      if (!sourcePane || !targetPane || !movingTab) return current;

      if (sourcePaneId !== targetPaneId && sourcePane.tabs.length <= 1) {
        return current;
      }

      return current.map((pane) => {
        if (sourcePaneId === targetPaneId && pane.id === sourcePaneId) {
          return moveTabWithinPane(pane, tabId, targetTabId, position);
        }

        if (pane.id === sourcePaneId) {
          const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
          const activeTabId = pane.activeTabId === tabId
            ? tabs[0]?.id ?? ""
            : pane.activeTabId;
          return { ...pane, tabs, activeTabId };
        }

        if (pane.id === targetPaneId) {
          const tabs = insertTab(pane.tabs, movingTab, targetTabId, position);
          return { ...pane, tabs, activeTabId: movingTab.id };
        }

        return pane;
      });
    });
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
    moveTab,
  };
});

function workbenchStorageKey(machineId: string | undefined): string {
  return `wgo.workbench.${machineId ?? "none"}.v1`;
}

function moveTabWithinPane(
  pane: WorkbenchPane,
  tabId: string,
  targetTabId: string | undefined,
  position: TabDropPosition,
): WorkbenchPane {
  if (targetTabId === tabId) return pane;

  const movingTab = pane.tabs.find((tab) => tab.id === tabId);
  if (!movingTab) return pane;

  const remainingTabs = pane.tabs.filter((tab) => tab.id !== tabId);
  const tabs = insertTab(remainingTabs, movingTab, targetTabId, position);
  return { ...pane, tabs, activeTabId: tabId };
}

function insertTab(
  tabs: WorkbenchTab[],
  tab: WorkbenchTab,
  targetTabId: string | undefined,
  position: TabDropPosition,
): WorkbenchTab[] {
  if (position === "end" || !targetTabId) return [...tabs, tab];

  const targetIndex = tabs.findIndex((item) => item.id === targetTabId);
  if (targetIndex < 0) return [...tabs, tab];

  const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
  return [
    ...tabs.slice(0, insertIndex),
    tab,
    ...tabs.slice(insertIndex),
  ];
}

function createFilesTab(): WorkbenchTab {
  return {
    id: `files-${crypto.randomUUID()}`,
    title: "Files",
    tool: "files",
  };
}
