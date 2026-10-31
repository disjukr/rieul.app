import { createSolidPlugin } from "./solid-plugin.ts";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("..", import.meta.url);
for (const [entry, target] of [
  ["src/host.ts", "node"],
  ["src/main.tsx", "bun"],
  ["scripts/runtime-preload.ts", "bun"],
] as const) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entry, root))],
    target,
    outdir: "dist",
    packages: "external",
    plugins: [createSolidPlugin()],
  });
  if (!result.success)
    throw new AggregateError(result.logs, `Failed to build ${entry}`);
}
await mkdir("dist/assets", { recursive: true });
await copyFile("assets/icon.ico", "dist/assets/icon.ico");
await copyFile("assets/tray.png", "dist/assets/tray.png");
await readFile(
  process.platform === "win32"
    ? "native/bin/rieul_pairing_windows.dll"
    : "native/bin/librieul_pairing_macos.dylib",
);
const ui = await readFile("dist/main.js", "utf8");
if (
  ui.includes("jsxDEV(") ||
  ui.includes("react/jsx") ||
  ui.includes('from "#gpuix"')
)
  throw new Error("Solid universal transform was not applied");
console.log("Node host + GPUiX Solid UI built.");
