import { ffi, type Pointer } from "./win-ffi.ts";

export function applyWindowsIcon(window: Pointer, file: string): () => void {
  const library = ffi.dlopen("user32.dll", {
    LoadImageW: {
      parameters: ["pointer", "buffer", "u32", "i32", "i32", "u32"],
      result: "pointer",
    },
    // WM_SETICON returns the previous icon handle.
    SendMessageW: {
      parameters: ["pointer", "u32", "usize", "pointer"],
      result: "pointer",
    },
    DestroyIcon: { parameters: ["pointer"], result: "i32" },
    GetWindowLongW: { parameters: ["pointer", "i32"], result: "i32" },
    SetWindowLongW: { parameters: ["pointer", "i32", "i32"], result: "i32" },
    SetWindowPos: {
      parameters: ["pointer", "pointer", "i32", "i32", "i32", "i32", "u32"],
      result: "i32",
    },
  } as const);
  const path = Buffer.from(`${file}\0`, "utf16le");
  const small = library.symbols.LoadImageW(null, path, 1, 16, 16, 0x10);
  const large = library.symbols.LoadImageW(null, path, 1, 32, 32, 0x10);
  if (!small || !large) {
    if (small) library.symbols.DestroyIcon(small);
    if (large) library.symbols.DestroyIcon(large);
    library.close();
    throw new Error("Cannot load native pairing window icons");
  }
  const oldSmall = library.symbols.SendMessageW(window, 0x80, 0n, small);
  const oldLarge = library.symbols.SendMessageW(window, 0x80, 1n, large);
  // Match the previous utility: close-to-hide is the sole titlebar action.
  const style = library.symbols.GetWindowLongW(window, -16);
  library.symbols.SetWindowLongW(window, -16, style & ~0x30000);
  library.symbols.SetWindowPos(window, null, 0, 0, 0, 0, 0x37);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    library.symbols.SetWindowLongW(window, -16, style);
    library.symbols.SetWindowPos(window, null, 0, 0, 0, 0, 0x37);
    library.symbols.SendMessageW(window, 0x80, 0n, oldSmall);
    library.symbols.SendMessageW(window, 0x80, 1n, oldLarge);
    library.symbols.DestroyIcon(small);
    library.symbols.DestroyIcon(large);
    library.close();
  };
}
