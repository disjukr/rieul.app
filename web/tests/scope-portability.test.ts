import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);

test("machine and workbench identities can be imported without any React adapter", async () => {
  const modules = ["machine-scopes.ts", "workbench-scopes.ts"].map(
    (name) => new URL(`../src/state/${name}`, import.meta.url).href,
  );
  // Reject framework imports rather than relying on a React-free environment
  // that could accidentally resolve React through a transitive dependency.
  const source = `
    import { registerHooks } from "node:module";
    import { createBunjaStore, bunja, createReadScopeFn } from "bunja";
    import assert from "node:assert/strict";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "react" || specifier.startsWith("react/") || specifier === "bunja/react") throw new Error("React leaked into domain identity: " + specifier);
      return next(specifier, context);
    } });
    const machine = await import(${JSON.stringify(modules[0])});
    const workbench = await import(${JSON.stringify(modules[1])});
    const model = bunja(() => ({ machine: bunja.use(machine.MachineIdScope), baseUrl: bunja.use(machine.MachineBaseUrlScope), pane: bunja.use(workbench.WorkbenchPaneIdScope), tab: bunja.use(workbench.WorkbenchTabIdScope) }));
    const store = createBunjaStore();
    const read = createReadScopeFn([[machine.MachineIdScope, "machine"], [machine.MachineBaseUrlScope, "https://fixture.invalid"], [workbench.WorkbenchPaneIdScope, "pane"], [workbench.WorkbenchTabIdScope, "tab"]], () => { throw new Error("missing scope"); });
    const entry = store.get(model, read); const stop = entry.mount();
    assert.deepEqual(entry.value, { machine: "machine", baseUrl: "https://fixture.invalid", pane: "pane", tab: "tab" });
    stop(); store.dispose();
  `;
  await exec(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: fileURLToPath(new URL("../", import.meta.url)) },
  );
});
