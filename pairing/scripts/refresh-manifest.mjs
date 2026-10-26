import path from "node:path";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = await realpath(path.resolve(process.argv[2]));
const manifestPath = path.join(root, "bundle.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const relative of Object.keys(manifest.files)) {
  if (
    relative
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..") ||
    path.isAbsolute(relative)
  )
    throw new Error(`Unsafe manifest path: ${relative}`);
  const file = await realpath(path.join(root, relative));
  const contained = path.relative(root, file);
  if (contained.startsWith("..") || path.isAbsolute(contained))
    throw new Error(`Manifest path escapes bundle: ${relative}`);
  manifest.files[relative] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
