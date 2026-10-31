import { onCleanup, type Accessor } from "solid-js";
import {
  layoutReducer,
  type LayoutState,
  type Direction,
  type BranchNode,
} from "../../../state/layout.ts";
export function PaneDivider(props: {
  nodeId: string;
  index: number;
  direction: Direction;
  layout: Accessor<LayoutState>;
  onChange: (layout: LayoutState) => void;
}) {
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());
  function resize(delta: number, start: number[], size: number) {
    const ratios = [...start];
    const pair = ratios[props.index] + ratios[props.index + 1];
    const minimum = Math.min(
      pair / 2,
      (props.direction === "horizontal" ? 320 : 220) / size,
    );
    const next = Math.max(
      minimum,
      Math.min(pair - minimum, ratios[props.index] + delta),
    );
    ratios[props.index] = next;
    ratios[props.index + 1] = pair - next;
    props.onChange(
      layoutReducer(props.layout(), {
        type: "RESIZE",
        nodeId: props.nodeId,
        dividerIndex: props.index,
        ratios,
      }),
    );
  }
  function pointer(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    event.preventDefault();
    event.stopPropagation();
    stop?.();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    const size = props.direction === "horizontal" ? rect.width : rect.height;
    const origin =
      props.direction === "horizontal" ? event.clientX : event.clientY;
    const start = [
      ...(props.layout().nodes[props.nodeId] as BranchNode).ratios,
    ];
    function move(e: PointerEvent) {
      if (e.pointerId !== event.pointerId) return;
      e.preventDefault();
      resize(
        ((props.direction === "horizontal" ? e.clientX : e.clientY) - origin) /
          size,
        start,
        size,
      );
    }
    function end() {
      stop?.();
    }
    stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      stop = undefined;
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  }
  function key(event: KeyboardEvent & { currentTarget: HTMLDivElement }) {
    const decrement =
        props.direction === "horizontal" ? "ArrowLeft" : "ArrowUp",
      increment = props.direction === "horizontal" ? "ArrowRight" : "ArrowDown";
    if (event.key !== decrement && event.key !== increment) return;
    event.preventDefault();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    resize(
      (event.key === decrement ? -1 : 1) * (event.shiftKey ? 0.1 : 0.02),
      [...(props.layout().nodes[props.nodeId] as BranchNode).ratios],
      props.direction === "horizontal" ? rect.width : rect.height,
    );
  }
  return (
    <div
      role="separator"
      tabindex={0}
      aria-orientation={
        props.direction === "horizontal" ? "vertical" : "horizontal"
      }
      aria-label="Resize panes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(
        (props.layout().nodes[props.nodeId] as BranchNode).ratios[props.index] *
          100,
      )}
      class={`relative z-[5] shrink-0 touch-none bg-transparent hover:bg-rieul-accent/20 focus-visible:bg-rieul-accent/20 ${props.direction === "horizontal" ? "w-[8px] cursor-col-resize" : "h-[8px] cursor-row-resize"}`}
      onPointerDown={pointer}
      onKeyDown={key}
    />
  );
}
