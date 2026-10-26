import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// A missing mount directory is not proof of detachment: the device may remain.
// Compare canonical image identity and the device returned by our own attach.
export function ownImageAttached(
  image,
  device,
  images,
  canonical = realpathSync,
) {
  if (
    typeof image !== "string" ||
    !path.isAbsolute(image) ||
    !/^\/dev\/disk\d+$/.test(device) ||
    !Array.isArray(images)
  )
    throw new Error("Invalid owned image identity");
  const expected = canonical(image);
  for (const entry of images) {
    if (
      !entry ||
      typeof entry.image !== "string" ||
      !path.isAbsolute(entry.image)
    )
      throw new Error("Invalid disk image inventory");
    if (canonical(entry.image) !== expected) continue;
    if (entry.device !== device)
      throw new Error("Owned image device changed; refusing detachment");
    return true;
  }
  return false;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [image, device, ...pairs] = process.argv.slice(2);
    if (pairs.length % 2) throw new Error("Incomplete image inventory");
    const images = [];
    for (let i = 0; i < pairs.length; i += 2)
      images.push({ image: pairs[i], device: pairs[i + 1] });
    process.exitCode = ownImageAttached(image, device, images) ? 0 : 1;
  } catch {
    console.error(
      "Cannot establish owned disk image state; refusing detachment",
    );
    process.exitCode = 2;
  }
}
