import { createRenderer } from "@solidjs/universal";
// Intentionally inspect the published host implementation, without importing
// the package's v1 root/components/native-window entry or modifying it.
const host = await import(
  new URL("host.js", import.meta.resolve("@gpuix/solid"))
);
const runtime = createRenderer({
  createElement: host.createHostElement,
  createTextNode: host.createHostText,
  replaceText: host.replaceHostText,
  setProperty: host.setHostProperty,
  insertNode: host.insertHostNode,
  removeNode: host.removeHostNode,
  isTextNode: host.isHostText,
  getParentNode: host.getParentNode,
  getFirstChild: host.getFirstChild,
  getNextSibling: host.getNextSibling,
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
export { For, Show } from "solid-js";
export { runtime, host };
