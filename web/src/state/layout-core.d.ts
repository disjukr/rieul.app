/**
 * Layout tree node type definitions
 *
 * Layout is represented as a tree structure:
 * - LeafNode: Panel that contains actual content
 * - BranchNode: Container that splits children horizontally/vertically
 */
/** Pane ID type */
type PaneId = string;
/** Node ID type */
type NodeId = string;
/** Split direction */
type Direction = "horizontal" | "vertical";
/** Leaf node - panel that contains actual content */
interface LeafNode {
  type: "leaf";
  id: NodeId;
  paneId: PaneId;
}
/** Branch node - container that splits children */
interface BranchNode {
  type: "branch";
  id: NodeId;
  direction: Direction;
  children: NodeId[];
  /** Ratio of each child (between 0-1, sum equals 1) */
  ratios: number[];
}
/** Node union type */
type LayoutNode = LeafNode | BranchNode;
/**
 * Layout state
 *
 * Stores nodes in a flat structure and references by id.
 * This makes tree restructuring easier when moving/deleting nodes.
 */
interface LayoutState {
  /** All nodes indexed by id */
  nodes: Record<NodeId, LayoutNode>;
  /** Root node ID */
  rootId: NodeId | null;
}
/** Drop zone - split: split the panel, edge: add sibling to parent */
type DropZone = "split" | "edge";
/** Drop side direction */
type DropSide = "left" | "right" | "top" | "bottom" | "center";
/** Drop position info */
interface DropPosition {
  side: DropSide;
  zone: DropZone;
}
/** Drop target info */
export interface DropTarget {
  nodeId: NodeId;
  side: DropSide;
  zone: DropZone;
}
/** Resize event */
export interface ResizeEvent {
  nodeId: NodeId;
  /** Index of the changed divider */
  dividerIndex: number;
  /** New ratios */
  ratios: number[];
}
/** Layout change actions */
type LayoutAction =
  | {
      type: "ADD_PANE";
      paneId: PaneId;
      targetNodeId?: NodeId;
      side?: DropSide;
    }
  | {
      type: "REMOVE_PANE";
      nodeId: NodeId;
    }
  | {
      type: "MOVE_PANE";
      sourceNodeId: NodeId;
      targetNodeId: NodeId;
      position: DropPosition;
    }
  | {
      type: "SPLIT";
      nodeId: NodeId;
      direction: Direction;
      paneId: PaneId;
      position: "before" | "after";
    }
  | {
      type: "RESIZE";
      nodeId: NodeId;
      dividerIndex: number;
      ratios: number[];
    }
  | {
      type: "SET_LAYOUT";
      layout: LayoutState;
    };
//#endregion

declare function layoutReducer(
  state: LayoutState,
  action: LayoutAction,
): LayoutState;
interface LayoutBuilder {
  leaf(paneId: string): string;
  horizontal(children: string[], ratios?: number[]): string;
  vertical(children: string[], ratios?: number[]): string;
}
declare function createLayout(
  builder: (builder: LayoutBuilder) => string,
): LayoutState;
export {
  createLayout,
  layoutReducer,
  type LayoutState,
  type LayoutNode,
  type LayoutAction,
  type Direction,
  type BranchNode,
};
