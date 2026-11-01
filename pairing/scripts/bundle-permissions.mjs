import { chmod, lstat, readdir, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const publicPolicy = JSON.parse(await readFile(
  new URL("../public-macos-bundle.json", import.meta.url), "utf8",
));
function publicMode(relative, directory) {
  const dataTree = publicPolicy.dataTrees.some(
    (tree) => relative === tree || relative.startsWith(tree + "/"),
  );
  if (directory)
    return dataTree || publicPolicy.directories.includes(relative) ? 0o755 : null;
  if (publicPolicy.executableFiles.includes(relative)) return 0o755;
  return dataTree || publicPolicy.dataFiles.includes(relative) ? 0o644 : null;
}

// Only use normalization on private, unsigned staging trees. Verification is
// read-only and also runs on the extracted archive, after signing.
export async function bundlePermissions(directory, normalize = false, publicMacOS = false) {
  const root = path.resolve(directory);
  if (!(await lstat(root)).isDirectory())
    throw new Error(`Bundle root must be a real directory: ${root}`);
  const canonicalRoot = await realpath(root);
  const entries = [];
  async function visit(file) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      const target = await realpath(file);
      const relative = path.relative(canonicalRoot, target);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(`Bundle symlink escapes root: ${file}`);
      return; // Never chmod or traverse a symlink.
    }
    if (!info.isDirectory() && !info.isFile())
      throw new Error(`Unsupported special file in bundle: ${file}`);
    if (info.isFile() && info.nlink !== 1)
      throw new Error(`Hard-linked file in bundle: ${file}`);
    if (info.mode & 0o7000)
      throw new Error(`Special permission bits in bundle: ${file}`);
    if (!normalize && info.mode & 0o022)
      throw new Error(`Group/world-writable bundle entry: ${file}`);
    // Only the explicit public payload allowlist gains read/search permissions.
    // Never broaden access to unknown files (credentials, profiles, etc.).
    const relative = path.relative(root, file).split(path.sep).join("/");
    const required = publicMacOS ? publicMode(relative, info.isDirectory()) : null;
    const mode = info.mode & 0o777;
    if (!normalize && required !== null && mode !== required)
      throw new Error(`Public bundle entry needs mode ${required.toString(8)}: ${file}`);
    entries.push([file, mode, required]);
    if (info.isDirectory())
      for (const name of await readdir(file))
        await visit(path.join(file, name));
  }
  await visit(root);
  if (normalize)
    for (const [file, mode, required] of entries) {
      const target = required ?? (mode & ~0o022);
      if (mode !== target) await chmod(file, target);
    }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [operation, directory] = process.argv.slice(2);
  if (!["normalize", "verify", "normalize-public-macos", "verify-public-macos"].includes(operation) || !directory)
    throw new Error("Usage: bundle-permissions.mjs normalize|verify|normalize-public-macos|verify-public-macos DIRECTORY");
  await bundlePermissions(directory, operation.startsWith("normalize"), operation.endsWith("-public-macos"));
}
