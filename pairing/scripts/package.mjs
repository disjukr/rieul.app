import { cp, mkdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { prepareRuntimes, execute, root, sha256 } from "./runtimes.mjs";
const windows = process.platform === "win32";
if (!windows && process.platform !== "darwin")
  throw new Error("Desktop packaging supports Windows/macOS");
const arg = process.argv.indexOf("--out");
const output = path.resolve(
  arg < 0
    ? path.join(
        root,
        "../target/release",
        windows ? "rieul-windows-gui" : "Rieul-desktop.app",
      )
    : process.argv[arg + 1],
);
if (
  await stat(output).then(
    () => true,
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  )
)
  throw new Error(
    `Bundle already exists; choose a fresh output directory: ${output}`,
  );
const bundle = windows
  ? output
  : path.join(output, "Contents/Resources/pairing");
await mkdir(bundle, { recursive: true });
const runtime = await prepareRuntimes(path.join(bundle, "runtime"));
const cargo = process.env.RIEUL_CARGO ?? "cargo";
const rustc = process.env.RIEUL_RUSTC ?? "rustc";
await execute(
  cargo,
  [
    "build",
    "--manifest-path",
    path.resolve(root, "../Cargo.toml"),
    "-p",
    "rieul-gui-launcher",
    "--release",
    "--locked",
  ],
  { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
);
if (windows)
  await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      path.join(root, "scripts/build-bridge.ps1"),
      "-Rustc",
      rustc,
    ],
    { windowsHide: true },
  );
else
  await execute("/bin/sh", [path.join(root, "scripts/build-bridge-macos.sh")]);
await execute(runtime.bun, ["install", "--frozen-lockfile"], {
  cwd: root,
  windowsHide: true,
});
await execute(runtime.bun, ["scripts/build.ts"], {
  cwd: root,
  windowsHide: true,
});
const app = path.join(bundle, "app");
await mkdir(path.join(app, "native/bin"), { recursive: true });
for (const name of ["dist", "package.json", "bun.lock", "bunfig.toml"])
  await cp(path.join(root, name), path.join(app, name), { recursive: true });
const bridge = windows
  ? "rieul_pairing_windows.dll"
  : "librieul_pairing_macos.dylib";
await cp(
  path.join(root, "native/bin", bridge),
  path.join(app, "native/bin", bridge),
);
await execute(runtime.bun, ["install", "--production", "--frozen-lockfile"], {
  cwd: app,
  windowsHide: true,
});
let addon = windows
  ? "@gpuix/native-win32-x64-msvc/gpuix-native.win32-x64-msvc.node"
  : "@gpuix/native-darwin-arm64/gpuix-native.darwin-arm64.node";
if (!windows && process.arch === "x64") {
  if (!process.env.RIEUL_NATIVE_ADDON)
    throw new Error(
      "Intel macOS requires the pinned official 0.11 native source build; run build-native-macos-intel.sh first",
    );
  addon = "@gpuix/native/gpuix-native.darwin-x64.node";
  await cp(
    process.env.RIEUL_NATIVE_ADDON,
    path.join(app, "node_modules", addon),
  );
}
for (const name of ["native", "solid"]) {
  const metadata = JSON.parse(
    await readFile(
      path.join(app, "node_modules/@gpuix", name, "package.json"),
      "utf8",
    ),
  );
  if (metadata.version !== "0.11.0")
    throw new Error("GPUiX package versions must both equal 0.11.0");
}
const files = {};
for (const relative of [
  `runtime/node${windows ? ".exe" : ""}`,
  `runtime/bun${windows ? ".exe" : ""}`,
  "app/dist/host.js",
  "app/dist/main.js",
  `app/native/bin/${bridge}`,
  `app/node_modules/${addon}`,
])
  files[relative] = await sha256(path.join(bundle, relative));
await writeFile(
  path.join(bundle, "bundle.json"),
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      node_version: runtime.nodeVersion,
      bun_version: runtime.bunVersion,
      files,
    },
    null,
    2,
  ),
);
const executable = windows
  ? path.join(output, "rieul-windows-gui.exe")
  : path.join(output, "Contents/MacOS/rieul-gui");
await mkdir(path.dirname(executable), { recursive: true });
await cp(
  path.resolve(
    root,
    `../target/release/rieul-gui-launcher${windows ? ".exe" : ""}`,
  ),
  executable,
);
if (!windows) {
  await chmod(executable, 0o755);
  await writeFile(
    path.join(output, "Contents/Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>rieul-gui</string><key>CFBundleIdentifier</key><string>app.rieul</string><key>CFBundleName</key><string>Rieul</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>',
  );
}
await execute(executable, ["--verify-bundle"], { windowsHide: true });
console.log(
  JSON.stringify({
    output,
    executable,
    platform: process.platform,
    arch: process.arch,
    runtimesBundled: true,
    integrityVerified: true,
  }),
);
