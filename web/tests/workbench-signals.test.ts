import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createBunjaStore, createReadScopeFn } from "bunja";
import { createRoot, flush } from "solid-js";
import { MachineIdScope } from "../src/state/machine-scopes.ts";
import { layoutReducer } from "../src/state/layout.ts";
import {
  workbenchBunja,
  workbenchPaneBunja,
  workbenchTabBunja,
  WorkbenchPaneIdScope,
  WorkbenchTabIdScope,
} from "../src/state/workbench.ts";
import { layoutBunja } from "../src/view/state.tsx";

const storageKey = (machineId: string) => `rieul.workbench.${machineId}.v1`;
const initialWorkbench = {
  layout: {
    rootId: "n1",
    nodes: { n1: { type: "leaf", id: "n1", paneId: "p1" } },
  },
  activePaneId: "p1",
  panes: [
    {
      id: "p1",
      activeTabId: "t1",
      tabs: [{ id: "t1", title: "Files", tool: "files" }],
    },
  ],
};

function fixture(t: TestContext) {
  const values = new Map<string, string>([
    [storageKey("A"), JSON.stringify(initialWorkbench)],
    [storageKey("B"), JSON.stringify(initialWorkbench)],
  ]);
  const writes: string[] = [];
  const storage: Storage = {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes.push(key);
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
  };
  const listeners = new Map<string, Set<EventListener>>();
  const bodyStyle = { cursor: "default", userSelect: "text" };
  const globals = {
    localStorage: storage,
    innerWidth: 1280,
    document: { body: { style: bodyStyle } },
    addEventListener(name: string, callback: EventListener) {
      const callbacks = listeners.get(name) ?? new Set<EventListener>();
      callbacks.add(callback);
      listeners.set(name, callbacks);
    },
    removeEventListener(name: string, callback: EventListener) {
      listeners.get(name)?.delete(callback);
    },
  };
  const previous = Object.entries(globals).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    return { name, descriptor };
  });
  const store = createBunjaStore({ wrapInstance: (init) => createRoot(init) });
  t.after(() => {
    store.dispose();
    flush();
    for (const { name, descriptor } of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  function read(machineId: string, paneId = "p1", tabId = "t1") {
    return createReadScopeFn(
      [
        [MachineIdScope, machineId],
        [WorkbenchPaneIdScope, paneId],
        [WorkbenchTabIdScope, tabId],
      ],
      () => {
        throw new Error("Unexpected scope");
      },
    );
  }
  function emitStorage(key: string, storageArea: Storage = storage) {
    const event = {
      key,
      storageArea,
      newValue: storageArea.getItem(key),
    } as StorageEvent;
    for (const callback of listeners.get("storage") ?? []) callback(event);
  }
  return {
    store,
    read,
    values,
    writes,
    storage,
    listeners,
    emitStorage,
    bodyStyle,
  };
}

test("workbench commands compose queued writes and return results before the Solid UI commits", (t) => {
  const f = fixture(t);
  const entry = f.store.get(workbenchBunja, f.read("A"));
  entry.mount();
  const workbench = entry.value;
  const originalLayout = workbench.layout();
  const addedId = workbench.addDaemonTab("p1");
  const duplicatedId = workbench.duplicateTab("p1", addedId);
  assert.ok(
    duplicatedId,
    "duplicate must find the tab queued by the preceding command",
  );
  workbench.setTabDirty("p1", duplicatedId, true);
  workbench.setDaemonClientsPageOpen("p1", addedId, true);
  workbench.setDaemonClientDetailId("p1", addedId, "client-fixture");

  assert.equal(
    workbench.panes()[0].tabs.length,
    1,
    "native accessors retain committed values until flush",
  );
  const persisted = JSON.parse(f.values.get(storageKey("A"))!) as {
    panes: {
      tabs: {
        id: string;
        dirty?: boolean;
        daemonClientsPageOpen?: boolean;
        daemonClientDetailId?: string;
      }[];
    }[];
  };
  assert.equal(persisted.panes[0].tabs.length, 3);
  assert.equal(
    persisted.panes[0].tabs.find((tab) => tab.id === duplicatedId)?.dirty,
    true,
  );
  assert.equal(
    persisted.panes[0].tabs.find((tab) => tab.id === addedId)
      ?.daemonClientsPageOpen,
    true,
  );
  assert.equal(
    persisted.panes[0].tabs.find((tab) => tab.id === addedId)
      ?.daemonClientDetailId,
    "client-fixture",
  );

  const newPaneId = workbench.addPane("p1");
  workbench.setLayout(
    layoutReducer(originalLayout, {
      type: "SPLIT",
      nodeId: "n1",
      direction: "horizontal",
      paneId: newPaneId,
      position: "after",
    }),
  );
  assert.equal(
    workbench.moveTab("p1", duplicatedId, newPaneId, undefined, "end"),
    false,
  );
  flush();
  assert.equal(workbench.panes().length, 2);
  assert.ok(
    workbench
      .panes()
      .find((pane) => pane.id === newPaneId)
      ?.tabs.some((tab) => tab.id === duplicatedId),
  );
  assert.equal(
    Object.values(workbench.layout().nodes).filter(
      (node) => node.type === "leaf",
    ).length,
    2,
  );

  const pane = f.store.get(workbenchPaneBunja, f.read("A"));
  const tab = f.store.get(workbenchTabBunja, f.read("A"));
  pane.mount();
  tab.mount();
  assert.equal(pane.value.paneCount(), 2);
  assert.equal(tab.value.active(), false);
  tab.value.selectTab();
  tab.value.setDirty(true);
  flush();
  assert.equal(tab.value.active(), true);
  assert.equal(tab.value.focused(), true);
  assert.equal(tab.value.dirty(), true);
});

test("workbench shares storage observation per machine and releases only the final owner", (t) => {
  const f = fixture(t);
  const a = f.store.get(workbenchBunja, f.read("A"));
  const secondA = f.store.get(workbenchBunja, f.read("A"));
  const b = f.store.get(workbenchBunja, f.read("B"));
  assert.equal(a.value, secondA.value);
  assert.notEqual(a.value, b.value);
  const stopA = a.mount(),
    stopSecondA = secondA.mount(),
    stopB = b.mount();
  assert.equal(f.listeners.get("storage")?.size, 2);
  const external = {
    ...initialWorkbench,
    panes: [
      {
        ...initialWorkbench.panes[0],
        tabs: [{ ...initialWorkbench.panes[0].tabs[0], title: "External A" }],
      },
    ],
  };
  f.values.set(storageKey("A"), JSON.stringify(external));
  const before = f.writes.length;
  f.emitStorage(storageKey("A"), { ...f.storage });
  flush();
  assert.equal(
    a.value.panes()[0].tabs[0].title,
    "Files",
    "another storage area must be ignored",
  );
  f.emitStorage(storageKey("A"));
  flush();
  assert.equal(a.value.panes()[0].tabs[0].title, "External A");
  assert.equal(b.value.panes()[0].tabs[0].title, "Files");
  assert.equal(
    f.writes.length,
    before,
    "external storage changes must not echo writes",
  );
  stopA();
  assert.equal(f.listeners.get("storage")?.size, 2);
  stopSecondA();
  assert.equal(f.listeners.get("storage")?.size, 1);
  external.panes[0].tabs[0].title = "Changed while unmounted";
  f.values.set(storageKey("A"), JSON.stringify(external));
  f.emitStorage(storageKey("A"));
  const remounted = f.store.get(workbenchBunja, f.read("A"));
  assert.notEqual(remounted.value, a.value);
  const stopRemounted = remounted.mount();
  assert.equal(
    remounted.value.panes()[0].tabs[0].title,
    "Changed while unmounted",
  );
  stopRemounted();
  stopB();
  assert.equal(f.listeners.get("storage")?.size, 0);
});

test("panel signal commands persist queued values and release storage, resize and transition resources", (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entry = f.store.get(layoutBunja, f.read("A"));
  const stop = entry.mount();
  const panel = entry.value;
  panel.setMachinePanelWidth((width) => width + 16);
  panel.setMachinePanelWidth((width) => width + 16);
  panel.toggleMachinePanel();
  panel.toggleMachinePanel();
  assert.equal(panel.machinePanelWidth(), 204);
  assert.equal(f.values.get("rieul.app-rail-width.v1"), "236");
  assert.equal(f.values.get("rieul.machine-panel-collapsed.v1"), "false");
  flush();
  assert.equal(panel.machinePanelWidth(), 236);
  assert.equal(panel.machinePanelCollapsed(), false);
  assert.equal(panel.machinePanelTransitioning(), true);
  panel.setMachinePanelWidth(250);
  panel.startMachinePanelResize({
    clientX: 10,
    preventDefault() {},
  } as PointerEvent);
  for (const callback of f.listeners.get("pointermove") ?? [])
    callback({ clientX: 20 } as PointerEvent);
  flush();
  assert.equal(
    panel.machinePanelWidth(),
    260,
    "resize starts at the queued width, not the previous rendered width",
  );
  f.values.set("rieul.machine-panel-collapsed.v1", "true");
  const before = f.writes.length;
  f.emitStorage("rieul.machine-panel-collapsed.v1");
  flush();
  assert.equal(panel.machinePanelCollapsed(), true);
  assert.equal(f.writes.length, before);
  stop();
  flush();
  for (const callbacks of f.listeners.values()) assert.equal(callbacks.size, 0);
  assert.deepEqual(f.bodyStyle, { cursor: "default", userSelect: "text" });
  assert.equal(panel.machinePanelTransitioning(), false);
  t.mock.timers.tick(1000);
  flush();
  assert.equal(panel.machinePanelTransitioning(), false);
  assert.equal(f.writes.length, before);
});

test("legacy agent tabs retain saved metadata without exposing agent commands", (t) => {
  const f = fixture(t);
  const legacy = {
    ...initialWorkbench,
    panes: [
      {
        id: "p1",
        activeTabId: "legacy",
        tabs: [
          {
            id: "legacy",
            title: "Saved session",
            tool: "agent",
            agentSessionId: "keep-session",
          },
        ],
      },
    ],
  };
  const saved = JSON.stringify(legacy);
  f.values.set(storageKey("A"), saved);
  const entry = f.store.get(workbenchBunja, f.read("A"));
  const release = entry.mount();
  assert.equal(entry.value.activeTool(), undefined);
  assert.equal(f.values.get(storageKey("A")), saved);
  assert.equal(f.writes.length, 0);
  entry.value.openDaemonTab();
  flush();
  const persisted = JSON.parse(f.values.get(storageKey("A"))!);
  assert.deepEqual(persisted.panes[0].tabs[0], legacy.panes[0].tabs[0]);
  assert.equal(entry.value.activeTool(), "daemon");
  entry.value.closeTab("p1", "legacy");
  flush();
  assert.equal(entry.value.panes()[0].tabs.length, 1);
  assert.equal(entry.value.panes()[0].tabs[0].tool, "daemon");
  release();
});
