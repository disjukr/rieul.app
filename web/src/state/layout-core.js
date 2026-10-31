// Pure layout implementation from panecake 0.0.1 (MIT), https://github.com/hyp3rflow/panecake.
// Kept verbatim to preserve persisted layout and reducer behavior during the renderer migration.
//#region src/core/utils.ts
/** Generate unique ID */
const generateId = () => {
  return Math.random().toString(36).slice(2, 11);
};

//#endregion
//#region src/core/node.ts
/** Find parent of a node */
const findParent = (state, nodeId) => {
  for (const node of Object.values(state.nodes))
    if (node.type === "branch" && node.children.includes(nodeId)) return node;
  return null;
};
/** Create leaf node */
const createLeafNode = (paneId) => {
  return {
    type: "leaf",
    id: generateId(),
    paneId,
  };
};
/** Create branch node */
const createBranchNode = (direction, children, ratios) => {
  const defaultRatios = children.map(() => 1 / children.length);
  return {
    type: "branch",
    id: generateId(),
    direction,
    children,
    ratios: ratios ?? defaultRatios,
  };
};

//#endregion
//#region src/core/reducer.ts
/** Get direction from side */
const sideToDirection = (side) => {
  return side === "left" || side === "right" ? "horizontal" : "vertical";
};
/** Check if side is before */
const isBefore = (side) => {
  return side === "left" || side === "top";
};
/** Check if two nodes are adjacent siblings */
const areAdjacentSiblings = (state, sourceNodeId, targetNodeId, side) => {
  const parent = findParent(state, targetNodeId);
  if (!parent) return false;
  const sourceIndex = parent.children.indexOf(sourceNodeId);
  const targetIndex = parent.children.indexOf(targetNodeId);
  if (sourceIndex === -1) return false;
  const direction = sideToDirection(side);
  if (parent.direction !== direction) return false;
  if (isBefore(side)) return sourceIndex === targetIndex - 1;
  else return sourceIndex === targetIndex + 1;
};
/** Split node and add new leaf (split zone) */
const splitNode = (state, newLeaf, targetNodeId, side) => {
  if (!state.nodes[targetNodeId]) return state;
  const newNodes = { ...state.nodes };
  newNodes[newLeaf.id] = newLeaf;
  const effectiveSide = side === "center" ? "right" : side;
  const direction = sideToDirection(effectiveSide);
  const parent = findParent(state, targetNodeId);
  if (parent && parent.direction === direction) {
    const childIndex = parent.children.indexOf(targetNodeId);
    const insertIndex = isBefore(effectiveSide) ? childIndex : childIndex + 1;
    const newChildren = [...parent.children];
    newChildren.splice(insertIndex, 0, newLeaf.id);
    const targetRatio = parent.ratios[childIndex];
    const newRatios = [...parent.ratios];
    newRatios[childIndex] = targetRatio / 2;
    newRatios.splice(insertIndex, 0, targetRatio / 2);
    const newParent = {
      ...parent,
      children: newChildren,
      ratios: newRatios,
    };
    newNodes[parent.id] = newParent;
    return {
      nodes: newNodes,
      rootId: state.rootId,
    };
  }
  const newBranch = createBranchNode(
    direction,
    isBefore(effectiveSide)
      ? [newLeaf.id, targetNodeId]
      : [targetNodeId, newLeaf.id],
  );
  newNodes[newBranch.id] = newBranch;
  if (parent) {
    const childIndex = parent.children.indexOf(targetNodeId);
    const newParent = {
      ...parent,
      children: [
        ...parent.children.slice(0, childIndex),
        newBranch.id,
        ...parent.children.slice(childIndex + 1),
      ],
      ratios: parent.ratios,
    };
    newNodes[parent.id] = newParent;
    return {
      nodes: newNodes,
      rootId: state.rootId,
    };
  }
  return {
    nodes: newNodes,
    rootId: newBranch.id,
  };
};
/** Add to parent as sibling (edge zone) */
const addToParentAsSibling = (state, newLeaf, targetNodeId, side) => {
  const parent = findParent(state, targetNodeId);
  const direction = sideToDirection(side);
  if (!parent || parent.direction !== direction)
    return splitNode(state, newLeaf, targetNodeId, side);
  const newNodes = { ...state.nodes };
  newNodes[newLeaf.id] = newLeaf;
  const targetIndex = parent.children.indexOf(targetNodeId);
  const insertIndex = isBefore(side) ? targetIndex : targetIndex + 1;
  const newChildren = [
    ...parent.children.slice(0, insertIndex),
    newLeaf.id,
    ...parent.children.slice(insertIndex),
  ];
  const targetRatio = parent.ratios[targetIndex];
  const newRatio = targetRatio / 2;
  const adjustedTargetRatio = targetRatio / 2;
  const newRatios = [...parent.ratios];
  newRatios[targetIndex] = adjustedTargetRatio;
  newRatios.splice(insertIndex, 0, newRatio);
  const newParent = {
    ...parent,
    children: newChildren,
    ratios: newRatios,
  };
  newNodes[parent.id] = newParent;
  return {
    nodes: newNodes,
    rootId: state.rootId,
  };
};
const removePaneNode = (state, nodeId) => {
  if (!state.nodes[nodeId]) return state;
  const newNodes = { ...state.nodes };
  delete newNodes[nodeId];
  if (state.rootId === nodeId)
    return {
      nodes: {},
      rootId: null,
    };
  const parent = findParent(state, nodeId);
  if (!parent)
    return {
      nodes: newNodes,
      rootId: state.rootId,
    };
  const childIndex = parent.children.indexOf(nodeId);
  const newChildren = parent.children.filter((id) => id !== nodeId);
  const newRatios = parent.ratios.filter((_, i) => i !== childIndex);
  const ratioSum = newRatios.reduce((a, b) => a + b, 0);
  const normalizedRatios = newRatios.map((r) => r / ratioSum);
  if (newChildren.length === 1) {
    const remainingChildId = newChildren[0];
    delete newNodes[parent.id];
    const grandParent = findParent(state, parent.id);
    if (grandParent) {
      const parentIndex = grandParent.children.indexOf(parent.id);
      const remainingChild = state.nodes[remainingChildId];
      if (
        remainingChild?.type === "branch" &&
        remainingChild.direction === grandParent.direction
      ) {
        delete newNodes[remainingChildId];
        const parentRatio = grandParent.ratios[parentIndex];
        const newGrandParent = {
          ...grandParent,
          children: [
            ...grandParent.children.slice(0, parentIndex),
            ...remainingChild.children,
            ...grandParent.children.slice(parentIndex + 1),
          ],
          ratios: [
            ...grandParent.ratios.slice(0, parentIndex),
            ...remainingChild.ratios.map((r) => r * parentRatio),
            ...grandParent.ratios.slice(parentIndex + 1),
          ],
        };
        newNodes[grandParent.id] = newGrandParent;
      } else {
        const newGrandParent = {
          ...grandParent,
          children: [
            ...grandParent.children.slice(0, parentIndex),
            remainingChildId,
            ...grandParent.children.slice(parentIndex + 1),
          ],
        };
        newNodes[grandParent.id] = newGrandParent;
      }
      return {
        nodes: newNodes,
        rootId: state.rootId,
      };
    }
    return {
      nodes: newNodes,
      rootId: remainingChildId,
    };
  }
  let finalChildren = [...newChildren];
  let finalRatios = [...normalizedRatios];
  for (let i = finalChildren.length - 1; i >= 0; i--) {
    const childId = finalChildren[i];
    const child = state.nodes[childId];
    if (child?.type === "branch" && child.direction === parent.direction) {
      delete newNodes[childId];
      const childRatio = finalRatios[i];
      finalChildren = [
        ...finalChildren.slice(0, i),
        ...child.children,
        ...finalChildren.slice(i + 1),
      ];
      finalRatios = [
        ...finalRatios.slice(0, i),
        ...child.ratios.map((r) => r * childRatio),
        ...finalRatios.slice(i + 1),
      ];
    }
  }
  const newParent = {
    ...parent,
    children: finalChildren,
    ratios: finalRatios,
  };
  newNodes[parent.id] = newParent;
  return {
    nodes: newNodes,
    rootId: state.rootId,
  };
};
/** Move pane to edge zone (add to parent as sibling) */
const movePaneToEdge = (state, sourceNode, targetNodeId, side) => {
  const parent = findParent(state, targetNodeId);
  const direction = sideToDirection(side);
  if (!parent || parent.direction !== direction)
    return movePaneToSplit(state, sourceNode, targetNodeId, side);
  let newState = removePaneNode(state, sourceNode.id);
  if (!newState.nodes[targetNodeId]) return state;
  return addToParentAsSibling(
    newState,
    createLeafNode(sourceNode.paneId),
    targetNodeId,
    side,
  );
};
/** Move pane to split zone (split target node) */
const movePaneToSplit = (state, sourceNode, targetNodeId, side) => {
  let newState = removePaneNode(state, sourceNode.id);
  if (!newState.nodes[targetNodeId]) return state;
  return splitNode(
    newState,
    createLeafNode(sourceNode.paneId),
    targetNodeId,
    side,
  );
};
const layoutReducer = (state, action) => {
  switch (action.type) {
    case "ADD_PANE": {
      const newLeaf = createLeafNode(action.paneId);
      if (!state.rootId)
        return {
          nodes: { [newLeaf.id]: newLeaf },
          rootId: newLeaf.id,
        };
      return splitNode(
        state,
        newLeaf,
        action.targetNodeId ?? state.rootId,
        action.side ?? "right",
      );
    }
    case "REMOVE_PANE":
      return removePaneNode(state, action.nodeId);
    case "MOVE_PANE": {
      const { sourceNodeId, targetNodeId, position } = action;
      const { side, zone } = position;
      if (sourceNodeId === targetNodeId) return state;
      const sourceNode = state.nodes[sourceNodeId];
      if (!sourceNode || sourceNode.type !== "leaf") return state;
      if (side === "center") return state;
      if (areAdjacentSiblings(state, sourceNodeId, targetNodeId, side))
        return state;
      if (zone === "edge")
        return movePaneToEdge(state, sourceNode, targetNodeId, side);
      else return movePaneToSplit(state, sourceNode, targetNodeId, side);
    }
    case "SPLIT": {
      const { nodeId, direction, paneId, position } = action;
      if (!state.nodes[nodeId]) return state;
      const newLeaf = createLeafNode(paneId);
      const newNodes = { ...state.nodes };
      newNodes[newLeaf.id] = newLeaf;
      const parent = findParent(state, nodeId);
      if (parent && parent.direction === direction) {
        const childIndex = parent.children.indexOf(nodeId);
        const insertIndex = position === "before" ? childIndex : childIndex + 1;
        const newChildren = [...parent.children];
        newChildren.splice(insertIndex, 0, newLeaf.id);
        const targetRatio = parent.ratios[childIndex];
        const newRatios = [...parent.ratios];
        newRatios[childIndex] = targetRatio / 2;
        newRatios.splice(insertIndex, 0, targetRatio / 2);
        const newParent = {
          ...parent,
          children: newChildren,
          ratios: newRatios,
        };
        newNodes[parent.id] = newParent;
        return {
          nodes: newNodes,
          rootId: state.rootId,
        };
      }
      const newBranch = createBranchNode(
        direction,
        position === "before" ? [newLeaf.id, nodeId] : [nodeId, newLeaf.id],
      );
      newNodes[newBranch.id] = newBranch;
      if (parent) {
        const childIndex = parent.children.indexOf(nodeId);
        const newParent = {
          ...parent,
          children: [
            ...parent.children.slice(0, childIndex),
            newBranch.id,
            ...parent.children.slice(childIndex + 1),
          ],
        };
        newNodes[parent.id] = newParent;
      }
      return {
        nodes: newNodes,
        rootId: parent ? state.rootId : newBranch.id,
      };
    }
    case "RESIZE": {
      const { nodeId, ratios } = action;
      const node = state.nodes[nodeId];
      if (!node || node.type !== "branch") return state;
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [nodeId]: {
            ...node,
            ratios,
          },
        },
      };
    }
    case "SET_LAYOUT":
      return action.layout;
    default:
      return state;
  }
};

//#endregion
//#region src/layout/builder.ts
var LayoutBuilder = class {
  nodes = {};
  leaf(paneId) {
    const node = createLeafNode(paneId);
    this.nodes[node.id] = node;
    return node.id;
  }
  horizontal(children, ratios) {
    const node = createBranchNode("horizontal", children, ratios);
    this.nodes[node.id] = node;
    return node.id;
  }
  vertical(children, ratios) {
    const node = createBranchNode("vertical", children, ratios);
    this.nodes[node.id] = node;
    return node.id;
  }
  build(rootId) {
    return {
      nodes: this.nodes,
      rootId,
    };
  }
};
const createLayout = (builder) => {
  const b = new LayoutBuilder();
  const rootId = builder(b);
  return b.build(rootId);
};

//#endregion

export { createLayout, layoutReducer };
