/** The cursor wire format is bounded PNG only; never interpret SVG or remote URLs. */
export function desktopCursorPng(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.length > 128 * 1024) return;
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n))
    return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return;
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 256 || height > 256) return;
  return { width, height };
}
