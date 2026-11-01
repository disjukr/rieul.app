import {
  cp,
  mkdir,
  readFile,
  writeFile,
  stat,
  chmod,
  mkdtemp,
  realpath,
  lstat,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { execute, root, sha256 } from "./runtimes.mjs";
import { publishReplacement } from "./publish.mjs";
import { bundlePermissions } from "./bundle-permissions.mjs";
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
const cargo = process.env.RIEUL_CARGO ?? "cargo";
const manifestPath = path.resolve(root, "../daemon/gui/Cargo.toml");
const guiTarget = path.resolve(root, "../daemon/gui/target");
const buildEnv = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0" };
await execute(
  cargo,
  [
    "build",
    "--manifest-path",
    manifestPath,
    "--features",
    "qa",
    "--release",
    "--locked",
  ],
  {
    env: buildEnv,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const executable = windows
  ? path.join(output, "rieul-windows-gui.exe")
  : path.join(output, "Contents/MacOS/rieul-gui");
await mkdir(path.dirname(executable), { recursive: true });
await cp(
  path.join(guiTarget, "release", `rieul-gpui${windows ? ".exe" : ""}`),
  executable,
);
await mkdir(path.join(bundle, "assets"), { recursive: true });
for (const name of ["tray.png", "icon.ico"])
  await cp(path.join(root, "assets", name), path.join(bundle, "assets", name));
await mkdir(path.join(bundle, "licenses"), { recursive: true });
for (const name of ["LICENSE", "LICENSE-MIT", "LICENSE-APACHE"])
  await cp(
    path.resolve(root, "..", name),
    path.join(bundle, "licenses", `Rieul-${name}`),
  );
const metadata = JSON.parse(
  (
    await execute(
      cargo,
      [
        "metadata",
        "--manifest-path",
        manifestPath,
        "--features",
        "qa",
        "--format-version",
        "1",
        "--locked",
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    )
  ).stdout,
);
const licenses = [];
for (const pkg of metadata.packages) {
  const directory = path.dirname(pkg.manifest_path);
  const licenseDir = path.join(
    bundle,
    "licenses",
    `${pkg.name}-${pkg.version}`,
  );
  await mkdir(licenseDir, { recursive: true });
  const names = (await readdir(directory)).filter((name) =>
    /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name),
  );
  const files = [];
  for (const name of names) {
    if (!(await stat(path.join(directory, name))).isFile()) continue;
    await cp(path.join(directory, name), path.join(licenseDir, name), {
      dereference: true,
    });
    files.push(name);
  }
  if (pkg.license_file) {
    const source = path.resolve(directory, pkg.license_file);
    const name = path.basename(source);
    if (!files.includes(name)) {
      await cp(source, path.join(licenseDir, name), { dereference: true });
      files.push(name);
    }
  }
  // Some upstream workspace crates keep common notices at the repository root.
  if (!files.length) {
    let parent = directory;
    for (
      let depth = 0;
      depth < 4 && !files.length;
      ++depth, parent = path.dirname(parent)
    ) {
      for (const name of await readdir(parent)) {
        if (
          !/^(LICENSE|LICENSE-APACHE|LICENSE-MIT|NOTICE)(\.txt|\.md)?$/.test(
            name,
          ) ||
          !(await stat(path.join(parent, name))).isFile()
        )
          continue;
        await cp(path.join(parent, name), path.join(licenseDir, name), {
          dereference: true,
        });
        files.push(name);
      }
    }
  }
  licenses.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    source: pkg.source,
    files,
  });
}
await writeFile(
  path.join(bundle, "licenses/dependencies.json"),
  JSON.stringify(licenses, null, 2) + "\n",
);
const files = {};
async function hashes(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      await hashes(path.join(directory, entry.name), relative + "/");
    else if (entry.isFile())
      files[relative] = await sha256(path.join(directory, entry.name));
    else throw new Error(`Unsupported native bundle entry: ${relative}`);
  }
}
await hashes(bundle);
await writeFile(
  path.join(bundle, "bundle.json"),
  JSON.stringify(
    {
      schema_version: 2,
      implementation: "rust-gpui",
      platform: process.platform,
      arch: process.arch,
      gpui_revision: "025d2a06ee7920777bf4947f11e46a1f52e62cbb",
      executable_sha256: await sha256(executable),
      files,
    },
    null,
    2,
  ) + "\n",
);
if (!windows) {
  await chmod(executable, 0o755);
  await writeFile(
    path.join(output, "Contents/Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>rieul-gui</string><key>CFBundleIdentifier</key><string>app.rieul</string><key>CFBundleName</key><string>Rieul</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>13.0</string></dict></plist>',
  );
  await bundlePermissions(output, true);
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
  await publishReplacement(output, destination, previous);
}
console.log(
  JSON.stringify({
    output: destination,
    executable: path.join(destination, path.relative(output, executable)),
    previous,
    platform: process.platform,
    arch: process.arch,
    runtimesBundled: false,
    implementation: "rust-gpui",
    integrityVerified: true,
  }),
);
