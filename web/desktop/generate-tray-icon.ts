import { Resvg } from "npm:@resvg/resvg-js@2.6.2";

const svg = await Deno.readTextFile(
  new URL("../public/favicon.svg", import.meta.url),
);
const trayPng = renderPng(32);
const icon = encodeIco([16, 24, 32, 48, 64, 128, 256].map(renderPng));

await Promise.all([
  Deno.writeFile(new URL("./tray.png", import.meta.url), trayPng),
  Deno.writeFile(new URL("./icon.ico", import.meta.url), icon),
  Deno.writeFile(new URL("../public/favicon.ico", import.meta.url), icon),
]);

function renderPng(size: number): Uint8Array {
  return new Resvg(svg, {
    background: "rgba(0,0,0,0)",
    fitTo: { mode: "width", value: size },
  }).render().asPng();
}

function encodeIco(images: Uint8Array[]): Uint8Array {
  const directorySize = 6 + images.length * 16;
  const output = new Uint8Array(
    directorySize + images.reduce((total, image) => total + image.length, 0),
  );
  const view = new DataView(output.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);

  let imageOffset = directorySize;
  images.forEach((image, index) => {
    const size = [16, 24, 32, 48, 64, 128, 256][index];
    const entryOffset = 6 + index * 16;
    output[entryOffset] = size === 256 ? 0 : size;
    output[entryOffset + 1] = size === 256 ? 0 : size;
    view.setUint16(entryOffset + 4, 1, true);
    view.setUint16(entryOffset + 6, 32, true);
    view.setUint32(entryOffset + 8, image.length, true);
    view.setUint32(entryOffset + 12, imageOffset, true);
    output.set(image, imageOffset);
    imageOffset += image.length;
  });

  return output;
}
