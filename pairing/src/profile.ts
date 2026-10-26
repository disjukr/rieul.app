import path from "node:path";
import { realpath, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export function defaultConfigPath() {
  if (process.platform === "darwin")
    return "/Library/Application Support/rieul/rieul.yaml";
  return path.join(
    process.env.ProgramData ?? "C:\\ProgramData",
    "Rieul",
    "rieul.yaml",
  );
}

export async function profile(config: string) {
  const absolute = path.resolve(config);
  const configPath = await realpath(absolute).catch(() => absolute);
  return { configPath, profileId: profileId(configPath) };
}
export function profileId(configPath: string, platform = process.platform) {
  const normalized =
    platform === "win32"
      ? configPath.startsWith("\\\\?\\UNC\\")
        ? `\\\\${configPath.slice(8)}`
        : configPath.replace(/^\\\\\?\\/, "")
      : configPath;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}
export function endpoint(
  profileId: string,
  platform = process.platform,
  uid = process.getuid?.() ?? 0,
) {
  if (platform === "win32")
    return `\\\\.\\pipe\\rieul-gui-profile-${profileId}`;
  if (platform === "darwin")
    return `/tmp/rieul-gui-profile-${profileId}-${uid}.sock`;
  throw new Error(`GUI IPC is unsupported on ${platform}`);
}
export async function daemonInfo(configPath: string, profileId: string) {
  const text = await readFile(configPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    },
  );
  const scalar = (key: string) =>
    text.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\s#]+)`, "m"))?.[1];
  const port =
    Number((scalar("listenAddr") ?? "0.0.0.0:9012").split(":").at(-1)) || 9012;
  const domain = scalar("domain");
  return {
    configPath,
    profileId,
    daemonVersion: process.env.RIEUL_DAEMON_VERSION ?? "dev",
    daemonUrl: `https://${domain || "localhost"}${domain && port === 443 ? "" : `:${port}`}`,
  };
}
