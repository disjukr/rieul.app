export function deploymentTargets(headers) {
  return headers
    .split(/Load command \d+/)
    .filter((block) =>
      /cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b/.test(block),
    )
    .flatMap((block) => [
      ...block.matchAll(
        block.includes("LC_BUILD_VERSION")
          ? /\bminos\s+(\d+)\.(\d+)(?:\.\d+)?/g
          : /\bversion\s+(\d+)\.(\d+)(?:\.\d+)?/g,
      ),
    ])
    .map(([, major, minor]) => [Number(major), Number(minor)]);
}
