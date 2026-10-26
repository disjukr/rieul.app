import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  cp,
  chmod,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const execute = promisify(execFile);
export const root = fileURLToPath(new URL("..", import.meta.url));
export const sha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
export async function prepareRuntimes(destination) {
  const lock = JSON.parse(
    await readFile(new URL("../runtime-lock.json", import.meta.url), "utf8"),
  );
  const key = `${process.platform}-${process.arch}`;
  const entries = lock.platforms[key];
  if (!entries) throw new Error(`Unsupported desktop architecture ${key}`);
  const cache = path.resolve(root, "../target/runtime-cache");
  await mkdir(cache, { recursive: true });
  await mkdir(destination, { recursive: true });
  const paths = {};
  for (const name of ["node", "bun"]) {
    const entry = entries[name];
    const archive = path.join(
      cache,
      path.basename(new URL(entry.url).pathname),
    );
    let bytes = await readFile(archive).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!bytes) {
      const response = await fetch(entry.url);
      if (!response.ok)
        throw new Error(
          `Runtime download failed ${response.status}: ${entry.url}`,
        );
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
        throw new Error(`Untrusted ${name} archive`);
      await writeFile(archive, bytes, { flag: "wx" });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Cached ${name} checksum mismatch`);
    const extract = await mkdtemp(path.join(cache, "extract-"));
    try {
      if (process.platform === "win32") {
        await execute(
          path.join(
            process.env.SystemRoot ?? "C:/Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $env:RIEUL_ARCHIVE -DestinationPath $env:RIEUL_EXTRACT -Force",
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              RIEUL_ARCHIVE: archive,
              RIEUL_EXTRACT: extract,
            },
          },
        );
      } else if (archive.endsWith(".tar.gz"))
        await execute("/usr/bin/tar", ["-xzf", archive, "-C", extract]);
      else await execute("/usr/bin/unzip", ["-q", archive, "-d", extract]);
      const output = path.join(
        destination,
        name + (process.platform === "win32" ? ".exe" : ""),
      );
      await cp(path.join(extract, entry.path), output);
      if (name === "node")
        await cp(
          path.join(extract, entry.path.split("/")[0], "LICENSE"),
          path.join(destination, "Node-LICENSE"),
        );
      if (process.platform !== "win32") await chmod(output, 0o755);
      paths[name] = output;
    } finally {
      const relative = path.relative(cache, extract);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Unsafe extraction cleanup path");
      await rm(extract, { recursive: true, force: true });
    }
  }
  await cp(
    path.join(root, "assets/licenses/Bun-1.3.9.md"),
    path.join(destination, "Bun-LICENSE.md"),
  );
  for (const name of ["node", "bun"]) {
    const actual = (
      await execute(paths[name], ["--version"], { windowsHide: true })
    ).stdout
      .trim()
      .replace(/^v/, "");
    if (actual !== lock[`${name}Version`])
      throw new Error(`${name} version mismatch ${actual}`);
    const architecture = (
      await execute(
        paths[name],
        ["-e", "console.log(process.platform+'-'+process.arch)"],
        { windowsHide: true },
      )
    ).stdout.trim();
    if (architecture !== key)
      throw new Error(`${name} architecture mismatch ${architecture}`);
  }
  return {
    ...paths,
    nodeVersion: lock.nodeVersion,
    bunVersion: lock.bunVersion,
  };
}
