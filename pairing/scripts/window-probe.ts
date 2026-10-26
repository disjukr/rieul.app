import { dlopen } from "bun:ffi";
import { fileURLToPath } from "node:url";
const pid = Number(process.argv[2]),
  operation = process.argv[3];
const bridge = dlopen(
  fileURLToPath(
    new URL("../native/bin/rieul_pairing_windows.dll", import.meta.url),
  ),
  {
    rieul_pairing_window: { args: ["u32"], returns: "ptr" },
    rieul_pairing_visible: { args: ["ptr"], returns: "i32" },
    rieul_pairing_close: { args: ["ptr"], returns: "void" },
  },
);
const window = bridge.symbols.rieul_pairing_window(pid);
if (!window) throw new Error("Fixture UI not found");
let icons;
if (operation === "icons") {
  const user = dlopen("user32.dll", {
    SendMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "ptr" },
    GetWindowLongW: { args: ["ptr", "i32"], returns: "i32" },
  });
  icons = {
    small: !!user.symbols.SendMessageW(window, 0x7f, 0n, 0n),
    large: !!user.symbols.SendMessageW(window, 0x7f, 1n, 0n),
    minimize: !!(user.symbols.GetWindowLongW(window, -16) & 0x20000),
    maximize: !!(user.symbols.GetWindowLongW(window, -16) & 0x10000),
  };
  user.close();
}
if (operation === "close") bridge.symbols.rieul_pairing_close(window);
if (operation === "tray" || operation === "quit") {
  const user = dlopen("user32.dll", {
    FindWindowW: { args: ["ptr", "ptr"], returns: "ptr" },
    PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
  });
  const tray = user.symbols.FindWindowW(
    Buffer.from(`RieulGPUiXTrayWindow-${pid}\0`, "utf16le"),
    null,
  );
  if (!tray) throw new Error("Fixture tray not found");
  if (
    !user.symbols.PostMessageW(
      tray,
      operation === "quit" ? 0x111 : 0x8001,
      operation === "quit" ? 2n : 0n,
      operation === "quit" ? 0n : 0x400n,
    )
  )
    throw new Error("Tray post failed");
  user.close();
}
console.log(
  JSON.stringify({
    visible: !!bridge.symbols.rieul_pairing_visible(window),
    icons,
  }),
);
bridge.close();
