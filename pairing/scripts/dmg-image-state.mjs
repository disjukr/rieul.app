import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

export function wholeImageDevice(entities) {
  if (
    !Array.isArray(entities) ||
    entities.some((entry) => !entry || typeof entry["dev-entry"] !== "string")
  )
    throw new Error("Invalid disk image entities");
  const devices = entities
    .map((entry) => entry["dev-entry"])
    .filter((device) => /^\/dev\/disk\d+$/.test(device));
  if (devices.length !== 1)
    throw new Error("Cannot uniquely identify whole image device");
  return devices[0];
}

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
    if (process.argv[2] === "--device-json") {
      console.log(wholeImageDevice(JSON.parse(readFileSync(0, "utf8"))));
    } else {
      const [image, device, ...pairs] = process.argv.slice(2);
      if (pairs.length % 2) throw new Error("Incomplete image inventory");
      const images = [];
      for (let i = 0; i < pairs.length; i += 2)
        images.push({ image: pairs[i], device: pairs[i + 1] });
      process.exitCode = ownImageAttached(image, device, images) ? 0 : 1;
    }
  } catch {
    console.error(
      "Cannot establish owned disk image state; refusing detachment",
    );
    process.exitCode = 2;
  }
}
