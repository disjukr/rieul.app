import { chmod, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Only use normalization on private, unsigned staging trees. Verification is
// read-only and also runs on the extracted archive, after signing.
export async function bundlePermissions(directory, normalize = false) {
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
    entries.push([file, info.mode & 0o777]);
    if (info.isDirectory())
      for (const name of await readdir(file))
        await visit(path.join(file, name));
  }
  await visit(root);
  if (normalize)
    for (const [file, mode] of entries)
      if (mode & 0o022) await chmod(file, mode & ~0o022);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [operation, directory] = process.argv.slice(2);
  if (!["normalize", "verify"].includes(operation) || !directory)
    throw new Error("Usage: bundle-permissions.mjs normalize|verify DIRECTORY");
  await bundlePermissions(directory, operation === "normalize");
}
