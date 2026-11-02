import "@unocss/reset/tailwind.css";
import "../../src/theme.css";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { RpcSupportSection } from "../../src/view/workbench/tool/daemon/rpc-support";
import { procs } from "../../src/protocol/generated/rpc";
function Fixture() {
  const [ids, setIds] = createSignal<number[] | undefined>([
    66, 66, 67, 68, 5, 6, 7, 8, 9, 10, 11, 20, 64, 999, 999,
  ]);
  return (
    <main style={{ padding: "20px", "font-family": "system-ui" }}>
      <button onClick={() => setIds(Object.values(procs).map((p) => p.id))}>
        All supported
      </button>{" "}
      <button onClick={() => setIds([])}>None supported</button>{" "}
      <button onClick={() => setIds(undefined)}>Information unavailable</button>
      <RpcSupportSection supportedProcIds={ids()} />
    </main>
  );
}
render(() => <Fixture />, document.getElementById("root")!);
