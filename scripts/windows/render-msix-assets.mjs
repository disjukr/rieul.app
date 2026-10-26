import path from "node:path";
import sharp from "sharp";
const [sourceSvg, destinationDir] = process.argv.slice(2);
if (!sourceSvg || !destinationDir)
  throw new Error("Expected source SVG and destination directory");
for (const [name, size] of [
  ["Square44x44Logo.png", 44],
  ["Square150x150Logo.png", 150],
  ["StoreLogo.png", 256],
]) {
  await sharp(sourceSvg)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(path.join(destinationDir, name));
}
