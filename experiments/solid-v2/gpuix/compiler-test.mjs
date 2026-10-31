import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { transformAsync } from "@babel/core";
import solid from "@solidjs/babel-plugin";
import typescript from "@babel/preset-typescript";
import { createSignal, flush } from "solid-js";
import { runtime, host } from "./runtime.mjs";
const nativeHost = await import(
  new URL("../../native/dist/host.js", import.meta.resolve("@gpuix/solid"))
);
const code = `
import { Show } from "solid-js";
export default function View(props: {count:()=>number; visible:()=>boolean; increment:()=>void}) {
 return <div><text onClick={props.increment} style={{color:props.count()>0?"red":"blue"}}>Count: {props.count()}</text><Show when={props.visible()}><text>Present</text></Show></div>;
}`;
const result = await transformAsync(code, {
  filename: "fixture.tsx",
  babelrc: false,
  configFile: false,
  plugins: [[solid, { generate: "universal", moduleName: "../runtime.mjs" }]],
  presets: [typescript],
});
assert(result?.code);
assert(!result.code.includes("react/jsx"));
const folder = new URL("./.generated/", import.meta.url);
await mkdir(folder, { recursive: true });
await writeFile(new URL("fixture.mjs", folder), result.code);
const { default: View } = await import(new URL("fixture.mjs", folder));
const batches = [];
const renderer = {
  applyBatch(json) {
    batches.push(JSON.parse(json));
    return [];
  },
};
const handlers = new Map();
const mutations = nativeHost.createMutationQueue(renderer, (ids) =>
  nativeHost.unregisterEventHandlers(handlers, ids),
);
let nextId = 0;
const root = new host.HostRoot({
  mutations,
  nativeRenderer: renderer,
  eventHandlers: handlers,
  allocateId: () => ++nextId,
});
const [count, setCount] = createSignal(0),
  [visible, setVisible] = createSignal(true);
const dispose = runtime.render(
  () => View({ count, visible, increment: () => setCount((v) => v + 1) }),
  root,
);
flush();
mutations.flushMutations();
const allText = (node) =>
  node.kind === "text"
    ? node.text
    : (node.children ?? []).map(allText).join("");
assert.equal(allText(root), "Count: 0Present");
assert(
  batches.flat().some((m) => m[0] === "setEventListener" && m[2] === "click"),
);
const clickable = root.children[0].children[0];
clickable.props.get("onClick")();
flush();
mutations.flushMutations();
assert.equal(allText(root), "Count: 1Present");
assert.equal(clickable.style.color, "red");
setVisible(false);
flush();
mutations.flushMutations();
assert.equal(allText(root), "Count: 1");
dispose();
for (const child of [...root.children]) host.removeHostNode(root, child);
mutations.flushMutations();
const batchCount = batches.length;
setCount(5);
flush();
mutations.flushMutations();
assert.equal(
  batches.length,
  batchCount,
  "disposed view must not mutate native host",
);
assert.equal(root.children.length, 0);
console.log(
  "PASS: Solid v2 universal compiler -> published GPUiX host: insert, event, reactive text/style, conditional removal, disposal",
);
await rm(folder, { recursive: true });
