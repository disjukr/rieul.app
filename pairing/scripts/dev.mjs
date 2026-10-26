import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const config = args.indexOf("--config");
if (config < 0 || !args[config + 1])
  throw new Error(
    "Development requires --config <explicit development profile>",
  );
args[config + 1] = path.resolve(args[config + 1]);
async function run(executable, arguments_, cwd) {
  const child = spawn(executable, arguments_, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Desktop command exited ${code}`)),
      );
    });
  } finally {
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
  }
}
await run(
  process.execPath,
  [path.join(root, "scripts/package.mjs"), "--replace"],
  root,
);
const executable =
  process.platform === "win32"
    ? "../target/release/rieul-windows-gui/rieul-windows-gui.exe"
    : "../target/release/Rieul-desktop.app/Contents/MacOS/rieul-gui";
await run(path.resolve(root, executable), args, root);
