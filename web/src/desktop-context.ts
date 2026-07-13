const CONFIG_PATH_QUERY_PARAM = "configPath";

export function withDesktopConfigPath(
  rawUrl: string,
  configPath: string,
): string {
  const url = new URL(rawUrl);
  url.searchParams.set(CONFIG_PATH_QUERY_PARAM, configPath);
  return url.toString();
}

export function desktopConfigPathFromUrl(rawUrl: string): string | undefined {
  try {
    const configPath = new URL(rawUrl).searchParams.get(
      CONFIG_PATH_QUERY_PARAM,
    )?.trim();
    return configPath || undefined;
  } catch {
    return undefined;
  }
}
