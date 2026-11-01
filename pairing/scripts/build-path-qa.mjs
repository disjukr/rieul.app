// Build the actual native entry point and package from a spaced Unicode checkout.
import { cp, mkdir, mkdtemp, symlink } from "node:fs/promises";
import path from "node:path";
import { root, execute } from "./build-tools.mjs";
const repo = path.resolve(root, "..");
await mkdir(path.join(repo, "tmp"), { recursive: true });
const fixture = await mkdtemp(
  path.join(repo, "tmp", "native build 공백 경로 "),
);
const filter = (source) =>
  !["target", "node_modules", ".git", "artifacts", "dist"].includes(
    path.basename(source),
  );
for (const name of [
  "Cargo.toml",
  "Cargo.lock",
  "bdl.yaml",
  "pnpm-lock.yaml",
  "daemon",
  "pairing",
  "protocol",
  "scripts/codegen",
  "package.json",
  "LICENSE",
  "LICENSE-MIT",
  "LICENSE-APACHE",
])
  await cp(path.join(repo, name), path.join(fixture, name), {
    recursive: true,
    filter,
  });
await symlink(
  path.join(repo, "node_modules"),
  path.join(fixture, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
await execute(
  process.execPath,
  [path.join(fixture, "pairing/scripts/package.mjs")],
  {
    cwd: fixture,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: path.join(repo, "daemon/gui/target"),
    },
    maxBuffer: 16 * 1024 * 1024,
  },
);
console.log(JSON.stringify({ spacedUnicodeSourceAndBundle: true, fixture }));
