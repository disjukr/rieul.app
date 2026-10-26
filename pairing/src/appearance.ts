import type { StyleDesc } from "@gpuix/native/host";

// From web/uno.config.ts and view/daemon-main at 2b938439e2aa.
export const text: StyleDesc = {
  color: "#20242d",
  fontSize: 12,
  lineHeight: 18,
};
export const column: StyleDesc = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
export const row: StyleDesc = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  minWidth: 0,
};
export const smallShadow = [
  {
    offsetX: 0,
    offsetY: 1,
    blurRadius: 2,
    spreadRadius: 0,
    color: "#20242d0f",
  },
  {
    offsetX: 0,
    offsetY: 1,
    blurRadius: 1,
    spreadRadius: 0,
    color: "#20242d08",
  },
];
export const button: StyleDesc = {
  ...text,
  ...row,
  justifyContent: "center",
  height: 28,
  paddingLeft: 8,
  paddingRight: 8,
  borderRadius: 4,
  backgroundColor: "#ffffff00",
  cursor: "pointer",
  keyboardFocusDim: false,
  hover: { backgroundColor: "#f7f8fb", borderColor: "#d8dde7" },
  focusVisible: { outlineWidth: 2, outlineColor: "#4f8cff", outlineOffset: 1 },
};
export const panel: StyleDesc = {
  ...column,
  flexGrow: 1,
  borderRadius: 16,
  borderWidth: 1,
  borderColor: "#ffffff75",
  backgroundColor: "#f8f8f980",
  overflow: "hidden",
  boxShadow: [
    {
      offsetX: 0,
      offsetY: 34,
      blurRadius: 90,
      spreadRadius: 0,
      color: "#131b2a36",
    },
    {
      offsetX: 0,
      offsetY: 10,
      blurRadius: 30,
      spreadRadius: 0,
      color: "#131b2a1f",
    },
    {
      offsetX: 0,
      offsetY: 1,
      blurRadius: 0,
      spreadRadius: 0,
      color: "#ffffffc2",
      inset: true,
    },
  ],
};
export const mono = process.platform === "win32" ? "Consolas" : "Menlo";

// GPUiX has no CSS radial background. Paint the original two circle gradients
// into a 2x RGBA image, preserving CSS farthest-corner radii and layer order.
// This is a background only; all text and controls remain native elements.
export function backdropPixels() {
  const width = 1280,
    height = 720;
  const pixels = Buffer.alloc(width * height * 4);
  const layers = [
    { x: 0.86, y: 0.18, stop: 0.29, alpha: 0.12, color: [56, 184, 111] },
    { x: 0.18, y: 0.08, stop: 0.31, alpha: 0.18, color: [79, 140, 255] },
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = [244, 245, 247];
      for (const layer of layers) {
        const radius =
          Math.hypot(
            Math.max(layer.x, 1 - layer.x) * width,
            Math.max(layer.y, 1 - layer.y) * height,
          ) * layer.stop;
        const alpha =
          layer.alpha *
          Math.max(
            0,
            1 - Math.hypot(x - layer.x * width, y - layer.y * height) / radius,
          );
        for (let c = 0; c < 3; c++)
          color[c] = color[c] * (1 - alpha) + layer.color[c] * alpha;
      }
      const offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(color[c]);
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

// Original Lucide 24px paths, rendered at the original 15–17px sizes.
export function icon(name: "clipboard" | "external" | "check" | "alert") {
  const paths = {
    clipboard:
      '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    external:
      '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${name === "check" ? "#4f8cff" : name === "alert" ? "#b42318" : "#20242d"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
