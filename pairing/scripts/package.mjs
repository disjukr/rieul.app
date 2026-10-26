import {
  cp,
  mkdir,
  readFile,
  writeFile,
  stat,
  chmod,
  mkdtemp,
  rename,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { prepareRuntimes, execute, root, sha256 } from "./runtimes.mjs";
const windows = process.platform === "win32";
if (!windows && process.platform !== "darwin")
  throw new Error("Desktop packaging supports Windows/macOS");
const arg = process.argv.indexOf("--out");
const destination = path.resolve(
  arg < 0
    ? path.join(
        root,
        "../target/release",
        windows ? "rieul-windows-gui" : "Rieul-desktop.app",
      )
    : process.argv[arg + 1],
);
const exists = await stat(destination).then(
  () => true,
  (error) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  },
);
if (exists && !process.argv.includes("--replace"))
  throw new Error(
    `Bundle already exists; use --replace to preserve it as a backup: ${destination}`,
  );
const relativeOutput = path.relative(path.resolve(root, ".."), destination);
if (
  exists &&
  !["target", "tmp"].some((prefix) =>
    relativeOutput.startsWith(prefix + path.sep),
  )
)
  throw new Error(
    "Replacement is restricted to this checkout's target/ or tmp/ outputs",
  );
if (exists) {
  const resolved = path.relative(
    await realpath(path.resolve(root, "..")),
    await realpath(destination),
  );
  if (
    (await lstat(destination)).isSymbolicLink() ||
    !["target", "tmp"].some((prefix) => resolved.startsWith(prefix + path.sep))
  )
    throw new Error(
      "Output replacement cannot cross a link or leave this checkout's disposable build directories",
    );
}
const output = exists ? await mkdtemp(destination + ".building-") : destination;
const bundle = windows
  ? output
  : path.join(output, "Contents/Resources/pairing");
await mkdir(bundle, { recursive: true });
const runtime = await prepareRuntimes(path.join(bundle, "runtime"));
if (!windows && process.arch === "x64" && !process.env.RIEUL_NATIVE_ADDON) {
  await execute(
    "/bin/sh",
    [path.join(root, "scripts/build-native-macos-intel.sh")],
    {
      env: {
        ...process.env,
        PATH: path.dirname(runtime.bun) + path.delimiter + process.env.PATH,
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  process.env.RIEUL_NATIVE_ADDON = path.resolve(
    root,
    "../target/native/gpuix-0.11.0/gpuix-native.darwin-x64.node",
  );
}
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
await mkdir(path.join(bundle, "licenses"), { recursive: true });
for (const name of ["LICENSE", "LICENSE-MIT", "LICENSE-APACHE"])
  await cp(
    path.resolve(root, "..", name),
    path.join(bundle, "licenses", `Rieul-${name}`),
  );
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
let previous;
if (exists) {
  previous = destination + `.previous-${Date.now()}`;
  if (
    path.dirname(previous) !== path.dirname(destination) ||
    !path.isAbsolute(destination)
  )
    throw new Error("Invalid output publication paths");
  await rename(destination, previous);
  try {
    await rename(output, destination);
  } catch (error) {
    await rename(previous, destination);
    throw error;
  }
}
console.log(
  JSON.stringify({
    output: destination,
    executable: path.join(destination, path.relative(output, executable)),
    previous,
    platform: process.platform,
    arch: process.arch,
    runtimesBundled: true,
    integrityVerified: true,
  }),
);
