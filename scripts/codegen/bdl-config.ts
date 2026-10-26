import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@std/yaml";
import type { ResolveModuleFile } from "@disjukr/bdl/ir/builder";

export type Paths = Record<string, string>;
interface BdlConfig {
  paths: Paths;
}

// BDL 0.8.3's IR builder is runtime-independent. Its published io/config uses
// runtime-specific filesystem APIs, so keep that small boundary here on Node.
export async function loadBdlConfig(config?: string) {
  const configPath = resolve(config || (await findBdlConfigPath()));
  return {
    configDirectory: dirname(configPath),
    bdlConfig: parse(await readFile(configPath, "utf8")) as BdlConfig,
  };
}

export function getResolveModuleFileFn(
  config: BdlConfig,
  configDirectory: string,
): ResolveModuleFile {
  return async (modulePath) => {
    const [packageName, ...fragments] = modulePath.split(".");
    const filePath = resolve(
      configDirectory,
      config.paths[packageName],
      fragments.join("/") + ".bdl",
    );
    return {
      fileUrl: pathToFileURL(filePath).href,
      text: await readFile(filePath, "utf8"),
    };
  };
}

export async function findBdlConfigPath(cwd = process.cwd()): Promise<string> {
  let directory = resolve(cwd);
  for (;;) {
    // Preserve BDL 0.8.3's yml-before-yaml and nearest-ancestor precedence.
    for (const name of ["bdl.yml", "bdl.yaml"]) {
      const candidate = join(directory, name);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`No bdl.yml or bdl.yaml found from ${cwd}`);
    directory = parent;
  }
}
