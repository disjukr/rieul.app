// App-local Solid v2 integration. GPUiX continues to own host mutations/events.
import { createRenderer } from "@solidjs/universal";
import { createContext, useContext, flush, type Element } from "solid-js";
import {
  createMutationQueue,
  createRendererState,
  unregisterEventHandlers,
  type HostProps,
  type KeyEvent,
} from "@gpuix/native/host";
import { GpuixRenderer } from "@gpuix/native";
import * as host from "../node_modules/@gpuix/solid/dist/host.js";
export { GpuixRenderer };
export type { HostElement } from "../node_modules/@gpuix/solid/dist/host.js";
const runtime = createRenderer<host.HostNode | host.HostRoot>({
  createElement: (tag, props) => {
    const node = host.createHostElement(tag);
    for (const [name, value] of Object.entries(props ?? {}))
      host.setHostProperty(node, name, value as host.HostPropertyValue);
    return node;
  },
  createTextNode: host.createHostText,
  replaceText: (node, value) =>
    host.replaceHostText(node as host.HostText, value),
  setProperty: (node, name, value) =>
    host.setHostProperty(
      node as host.HostElement,
      name,
      value as host.HostPropertyValue,
    ),
  insertNode: (parent, node, anchor) =>
    host.insertHostNode(
      parent as host.HostParent,
      node as host.HostNode,
      anchor as host.HostNode | undefined,
    ),
  removeNode: (parent, node) =>
    host.removeHostNode(parent as host.HostParent, node as host.HostNode),
  isTextNode: (node) => host.isHostText(node as host.HostNode),
  getParentNode: (node) => host.getParentNode(node as host.HostNode),
  getFirstChild: (node) => host.getFirstChild(node as host.HostParent),
  getNextSibling: (node) => host.getNextSibling(node as host.HostNode),
});
export const {
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  effect,
  memo,
  spread,
  setProp,
  mergeProps,
  applyRef,
  ref,
} = runtime;
const Context = createContext<GpuixRenderer>();
export function useGpuixRequired() {
  return useContext(Context);
}
export function createRoot(renderer: GpuixRenderer) {
  const state = createRendererState(renderer);
  const eventHandlers = new Map();
  const mutations = createMutationQueue(
    renderer,
    (ids) => {
      for (const id of ids) unregisterEventHandlers(eventHandlers, id);
    },
    queueMicrotask,
  );
  const container = new host.HostRoot({
    mutations,
    nativeRenderer: renderer,
    eventHandlers,
    allocateId: () => ++state.ids.nextElementId,
  });
  const binding = state.attach({ eventHandlers });
  renderer.setWindowKeyEvents?.(true, false, binding.windowKeyEventId);
  mutations.setKeyboardFocusDim(true);
  let dispose: (() => void) | undefined;
  const flushRoot = () => {
    flush();
    mutations.flushMutations();
  };
  const clear = () => {
    dispose?.();
    dispose = undefined;
    for (const child of [...container.children])
      host.removeHostNode(container, child);
    flushRoot();
    eventHandlers.clear();
  };
  return {
    render(code: () => Element) {
      clear();
      dispose = runtime.render(
        () =>
          runtime.createComponent(
            Context as unknown as (props: {
              value: GpuixRenderer;
              children: Element;
            }) => host.HostNode,
            {
              value: renderer,
              get children() {
                return code();
              },
            },
          ),
        container,
      );
      flushRoot();
    },
    flush: flushRoot,
    unmount() {
      clear();
      if (binding.detach())
        renderer.setWindowKeyEvents?.(false, false, binding.windowKeyEventId);
    },
  };
}
// Only the native button primitive used by this app: preserve Tab/Enter/Space.
export function Button(
  props: HostProps & { disabled?: boolean; children?: Element },
) {
  return (
    <div
      {...props}
      role="button"
      tabIndex={props.disabled ? -1 : (props.tabIndex ?? 0)}
      onClick={(event) => {
        if (!props.disabled) props.onClick?.(event);
      }}
      onKeyDown={(event: KeyEvent) => {
        props.onKeyDown?.(event);
        if (props.disabled || event.defaultPrevented) return;
        if (event.key === "enter" && !event.isHeld) props.onClick?.(event);
        if (event.key === "space") event.preventDefault();
      }}
      onKeyUp={(event: KeyEvent) => {
        props.onKeyUp?.(event);
        if (!props.disabled && !event.defaultPrevented && event.key === "space")
          props.onClick?.(event);
      }}
    >
      {props.children}
    </div>
  );
}
