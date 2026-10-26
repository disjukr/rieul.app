import { createSolidPlugin } from "@gpuix/solid/bun-plugin";
import { mkdir, copyFile, readFile } from "node:fs/promises";
const root = new URL("..", import.meta.url);
for (const [entry, target] of [
  ["src/host.ts", "node"],
  ["src/main.tsx", "bun"],
] as const) {
  const result = await Bun.build({
    entrypoints: [
      new URL(entry, root).pathname.replace(/^\/(?=[A-Za-z]:)/, ""),
    ],
    target,
    outdir: "dist",
    packages: "external",
    plugins: [createSolidPlugin()],
  });
  if (!result.success)
    throw new AggregateError(result.logs, `Failed to build ${entry}`);
}
await mkdir("dist/assets", { recursive: true });
await copyFile("../web/desktop/icon.ico", "dist/assets/icon.ico");
await readFile("native/bin/rieul_pairing_windows.dll");
const ui = await readFile("dist/main.js", "utf8");
if (ui.includes("jsxDEV(") || ui.includes("react/jsx"))
  throw new Error("Solid universal transform was not applied");
console.log(
  "Node host + GPUiX Solid UI built; existing CEF launcher unchanged.",
);
