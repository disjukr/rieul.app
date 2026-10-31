import type { LayoutState } from "../../../state/layout.ts";
import type { TabSplitDropSide } from "./tab-drag.ts";
import { createMemo, createSignal, For, onCleanup } from "solid-js";
import { WorkbenchPaneIdContext } from "../../../state/workbench-context.ts";
import { useAtomValue } from "../../../solid/jotai.tsx";
import { useBunja } from "../../../solid/bunja.tsx";
import { layoutReducer, type BranchNode } from "../../../state/layout.ts";
import { workbenchBunja } from "../../../state/workbench.ts";
import { WorkbenchPaneView } from "./pane-view.tsx";
import { PaneDivider } from "./pane-divider.tsx";
import type { WorkbenchTabDropTarget } from "./tab-drag.ts";
type Drag = {
  nodeId: string;
  paneId: string;
  tabId?: string;
  label: string;
};
type Target = {
  nodeId: string;
  paneId: string;
  tabId?: string;
  position?: "before" | "after" | "end";
  side?: TabSplitDropSide;
};
export function WorkbenchPaneLayout() {
  const workbench = useBunja(workbenchBunja);
  const layout = useAtomValue(() => workbench().layoutAtom);
  const [drag, setDrag] = createSignal<Drag>();
  const [target, setTarget] = createSignal<Target>();
  const [point, setPoint] = createSignal({
    x: 0,
    y: 0,
  });
  let stopPointer: (() => void) | undefined;
  function clear() {
    setDrag(undefined);
    setTarget(undefined);
    document.body.classList.remove("workbench-tab-dnd-active");
    document
      .querySelector(".app-shell")
      ?.classList.remove("workbench-tab-dnd-active");
  }
  onCleanup(() => {
    stopPointer?.();
    clear();
  });
  function resolve(x: number, y: number, active: Drag): Target | undefined {
    const hit = document.elementFromPoint(x, y);
    const pane = hit?.closest<HTMLElement>(
      "section[data-node-id][data-pane-id]",
    );
    if (!pane) return;
    const nodeId = pane.dataset.nodeId!,
      paneId = pane.dataset.paneId!;
    const tab = hit?.closest<HTMLElement>(".workbench-tab[data-tab-id]");
    if (tab && active.tabId) {
      const rect = tab.getBoundingClientRect();
      return {
        nodeId,
        paneId,
        tabId: tab.dataset.tabId,
        position: x < rect.left + rect.width / 2 ? "before" : "after",
      };
    }
    if (hit?.closest("[data-tab-strip]") && active.tabId)
      return {
        nodeId,
        paneId,
        position: "end",
      };
    const rect = pane.getBoundingClientRect();
    const edges = [
      {
        side: "left" as const,
        d: x - rect.left,
      },
      {
        side: "right" as const,
        d: rect.right - x,
      },
      {
        side: "top" as const,
        d: y - rect.top,
      },
      {
        side: "bottom" as const,
        d: rect.bottom - y,
      },
    ];
    return {
      nodeId,
      paneId,
      side: edges.sort((a, b) => a.d - b.d)[0].side,
    };
  }
  function drop(from: Drag, to: Target | undefined) {
    if (!from || !to) return;
    if (!from.tabId) {
      if (from.nodeId !== to.nodeId)
        workbench().setLayout(
          layoutReducer(layout(), {
            type: "MOVE_PANE",
            sourceNodeId: from.nodeId,
            targetNodeId: to.nodeId,
            position: {
              side: to.side ?? "right",
              zone: "split",
            },
          }),
        );
      return;
    }
    if (to.position) {
      workbench().moveTab(
        from.paneId,
        from.tabId,
        to.paneId,
        to.tabId,
        to.position,
      );
      return;
    }
    const moved = workbench().moveTabToNewPane(
      from.paneId,
      from.tabId,
      to.paneId,
    );
    if (!moved) return;
    let next = layout();
    if (moved.sourcePaneRemoved && next.nodes[from.nodeId])
      next = layoutReducer(next, {
        type: "REMOVE_PANE",
        nodeId: from.nodeId,
      });
    if (next.nodes[to.nodeId])
      workbench().setLayout(
        layoutReducer(next, {
          type: "SPLIT",
          nodeId: to.nodeId,
          paneId: moved.newPaneId,
          direction:
            to.side === "left" || to.side === "right"
              ? "horizontal"
              : "vertical",
          position:
            to.side === "left" || to.side === "top" ? "before" : "after",
        }),
      );
  }
  function start(event: PointerEvent) {
    if (event.button !== 0) return;
    const source = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-tab-drag], [data-pane-drag]",
    );
    if (!source) return;
    const pane = source.closest<HTMLElement>(
      "section[data-node-id][data-pane-id]",
    );
    if (!pane) return;
    const tab = source.closest<HTMLElement>("[data-tab-id]");
    const data: Drag = {
      nodeId: pane.dataset.nodeId!,
      paneId: pane.dataset.paneId!,
      tabId: tab?.dataset.tabId,
      label: source.getAttribute("title") ?? "Move pane",
    };
    const x = event.clientX,
      y = event.clientY;
    let started = false,
      cancelled = false;
    stopPointer?.();
    function activate() {
      if (cancelled) return;
      started = true;
      setDrag(data);
      setPoint({ x, y });
      document.body.classList.add("workbench-tab-dnd-active");
      document
        .querySelector(".app-shell")
        ?.classList.add("workbench-tab-dnd-active");
    }
    const timer =
      event.pointerType === "touch" ? setTimeout(activate, 250) : undefined;
    function move(e: PointerEvent) {
      if (e.pointerId !== event.pointerId) return;
      const distance = Math.hypot(e.clientX - x, e.clientY - y);
      if (!started) {
        if (event.pointerType === "touch") {
          if (distance > 5) {
            cancelled = true;
            clearTimeout(timer);
          }
        } else if (distance >= 4) activate();
      }
      if (!started) return;
      e.preventDefault();
      setPoint({
        x: e.clientX,
        y: e.clientY,
      });
      setTarget(resolve(e.clientX, e.clientY, data));
    }
    function touchMove(e: TouchEvent) {
      if (started) e.preventDefault();
    }
    function finish(e: PointerEvent) {
      if (e.pointerId !== event.pointerId) return;
      if (started && e.type === "pointerup") {
        const finalTarget = resolve(e.clientX, e.clientY, data);
        drop(data, finalTarget);
        document.addEventListener("click", suppressClick, {
          capture: true,
          once: true,
        });
      }
      stopPointer?.();
      clear();
    }
    function suppressClick(e: MouseEvent) {
      e.preventDefault();
      e.stopPropagation();
    }
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") {
        stopPointer?.();
        clear();
      }
    }
    stopPointer = () => {
      clearTimeout(timer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("touchmove", touchMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      document.removeEventListener("keydown", key);
      stopPointer = undefined;
    };
    document.addEventListener("pointermove", move, {
      passive: false,
    });
    document.addEventListener("touchmove", touchMove, { passive: false });
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    document.addEventListener("keydown", key);
  }
  const topRight = createMemo(() => topRightLeaf(layout()));
  function Node(props: { id: string }) {
    const node = createMemo(() => layout().nodes[props.id]);
    const identity = createMemo(() => {
      const value = node();
      return value?.type === "leaf" ? value.paneId : value?.type;
    });
    return (
      <>
        {(() => {
          const value = identity();
          const current =
            value === "branch"
              ? undefined
              : {
                  type: "leaf" as const,
                  id: props.id,
                  paneId: value!,
                };
          if (!value) return null;
          if (current)
            return (
              <WorkbenchPaneIdContext value={() => current.paneId}>
                <WorkbenchPaneView
                  canSplit
                  nodeId={current.id}
                  draggingTabId={drag()?.tabId}
                  topRight={topRight() === current.id}
                  tabDropTarget={
                    target()?.paneId === current.paneId && target()?.position
                      ? ({
                          position: target()!.position!,
                          tabId: target()?.tabId,
                        } as WorkbenchTabDropTarget)
                      : undefined
                  }
                  tabSplitDropSide={
                    target()?.paneId === current.paneId
                      ? target()?.side
                      : undefined
                  }
                />
              </WorkbenchPaneIdContext>
            );
          return <Branch id={props.id} />;
        })()}
      </>
    );
  }
  function Branch(props: { id: string }) {
    const node = createMemo(() => layout().nodes[props.id] as BranchNode);
    return (
      <div
        class="flex h-full w-full min-h-0 min-w-0"
        style={{
          "flex-direction":
            node().direction === "horizontal" ? "row" : "column",
        }}
      >
        <For each={node().children}>
          {(id, index) => (
            <>
              <div
                class="min-w-0 min-h-0 overflow-visible"
                style={{
                  flex: `${node().ratios[index()]} 1 0px`,
                }}
              >
                <Node id={id} />
              </div>
              {index() < node().children.length - 1 ? (
                <PaneDivider
                  nodeId={props.id}
                  index={index()}
                  direction={node().direction}
                  layout={layout}
                  onChange={(next) => workbench().setLayout(next)}
                />
              ) : null}
            </>
          )}
        </For>
      </div>
    );
  }
  return (
    <div
      class="workbench-pane-root w-full h-full min-w-0 min-h-0 overflow-visible p-[12px] rounded-[15px] max-[680px]:p-0 max-[680px]:rounded-none"
      onPointerDown={start}
    >
      {layout().rootId ? <Node id={layout().rootId!} /> : <div>No panes</div>}
      {drag() ? (
        <div
          class="fixed z-[100] pointer-events-none rounded-full bg-white px-3 py-1 shadow-lg"
          style={{
            left: `${point().x + 12}px`,
            top: `${point().y + 12}px`,
          }}
        >
          {drag()?.label}
        </div>
      ) : null}
    </div>
  );
}
function topRightLeaf(layout: LayoutState): string | undefined {
  let id = layout.rootId;
  while (id) {
    const node = layout.nodes[id];
    if (!node) return;
    if (node.type === "leaf") return id;
    id =
      node.direction === "horizontal"
        ? node.children.at(-1)!
        : node.children[0];
  }
}
