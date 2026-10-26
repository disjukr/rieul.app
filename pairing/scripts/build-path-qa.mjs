import { cp, mkdir, mkdtemp, symlink, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = path.join(root, "../tmp");
await mkdir(temp, { recursive: true });
const fixture = await mkdtemp(path.join(temp, "build 공백 경로 "));
const pairing = path.join(fixture, "pairing");
await mkdir(pairing, { recursive: true });
for (const name of [
  "src",
  "scripts/build.ts",
  "package.json",
  "tsconfig.json",
  "bunfig.toml",
  "native/bin/rieul_pairing_windows.dll",
  "assets",
])
  await cp(path.join(root, name), path.join(pairing, name), {
    recursive: true,
  });
for (const name of ["src/protocol"])
  await cp(path.join(root, "../web", name), path.join(fixture, "web", name), {
    recursive: true,
  });
await symlink(
  path.join(root, "node_modules"),
  path.join(pairing, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
const child = spawn(
  process.env.RIEUL_PAIRING_BUN ?? "bun",
  ["scripts/build.ts"],
  { cwd: pairing, stdio: "inherit", windowsHide: true },
);
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`Path QA build exited ${code}`)),
  );
});
for (const name of ["dist/host.js", "dist/main.js", "dist/assets/icon.ico"])
  await stat(path.join(pairing, name));
console.log(
  JSON.stringify({ fixture, actualBuild: true, spaceAndUnicodePath: true }),
);
