export function fileViewerSelectedImplStorageKey(
  machineId: string | undefined,
  tabId: string,
  path: string,
): string {
  return `rieul.file-viewer.impl.${machineId ?? "none"}.${tabId}.${path}`;
}

export function copyFileViewerState(
  machineId: string | undefined,
  sourceTabId: string,
  targetTabId: string,
) {
  try {
    const storage = globalThis.localStorage;
    const sourcePrefix = fileViewerSelectedImplStorageKeyPrefix(
      machineId,
      sourceTabId,
    );
    const targetPrefix = fileViewerSelectedImplStorageKeyPrefix(
      machineId,
      targetTabId,
    );
    for (const key of Object.keys(storage)) {
      if (!key.startsWith(sourcePrefix)) continue;
      const value = storage.getItem(key);
      const targetKey = `${targetPrefix}${key.slice(sourcePrefix.length)}`;
      if (value === null) storage.removeItem(targetKey);
      else storage.setItem(targetKey, value);
    }
  } catch {
    // Keep pane splitting usable even if persisted viewer state cannot be copied.
  }
}

function fileViewerSelectedImplStorageKeyPrefix(
  machineId: string | undefined,
  tabId: string,
): string {
  return `rieul.file-viewer.impl.${machineId ?? "none"}.${tabId}.`;
}
