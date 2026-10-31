import { ffi, type Pointer } from "./win-ffi.ts";
import { fileURLToPath } from "node:url";
const NIM_ADD = 0;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIM_SETVERSION = 4;
const NIF_MESSAGE = 1;
const NIF_ICON = 2;
const NIF_TIP = 4;
const NIF_INFO = 0x10;
const NIF_REALTIME = 0x40;
const NIIF_INFO = 1;
const NOTIFY_ICON_VERSION_4 = 4;
const NOTIFY_ICON_DATA_SIZE = 976;
const HWND_OFFSET = 8;
const UID_OFFSET = 16;
const FLAGS_OFFSET = 20;
const CALLBACK_MESSAGE_OFFSET = 24;
const ICON_OFFSET = 32;
const TIP_OFFSET = 40;
const INFO_OFFSET = 304;
const VERSION_OFFSET = 816;
const INFO_TITLE_OFFSET = 820;
const INFO_FLAGS_OFFSET = 948;

const WM_APP = 0x8000;
const WM_NULL = 0;
const TRAY_CALLBACK_MESSAGE = WM_APP + 1;

const ICON_RESOURCE_VERSION = 0x00030000;
const PM_REMOVE = 1;
const MF_STRING = 0;
const MF_SEPARATOR = 0x800;
const TPM_LEFTALIGN = 0;
const TPM_RIGHTBUTTON = 2;
const TPM_RETURNCMD = 0x100;
const MENU_DAEMON_INFO = 1;
const MENU_QUIT = 2;
const WNDCLASS_SIZE = 72;
const MSG_SIZE = 48;

export interface WindowsTrayOptions {
  icon: Uint8Array;
  onDaemonInfo(): void;
  onOpen(): void;
  onQuit(): void;
}

export interface WindowsTray {
  destroy(): void;
  showBalloon(title: string, body: string): void;
}

export function createWindowsTray(options: WindowsTrayOptions): WindowsTray {
  if (ffi.build.os !== "windows") {
    throw new Error("the native Windows tray is only available on Windows");
  }

  const kernel32 = ffi.dlopen("kernel32.dll", {
    GetLastError: { parameters: [], result: "u32" },
    GetModuleHandleW: { parameters: ["pointer"], result: "pointer" },
  } as const);
  const user32 = ffi.dlopen("user32.dll", {
    AppendMenuW: {
      parameters: ["pointer", "u32", "usize", "pointer"],
      result: "i32",
    },
    CreatePopupMenu: { parameters: [], result: "pointer" },
    CreateIconFromResourceEx: {
      parameters: ["buffer", "u32", "i32", "u32", "i32", "i32", "u32"],
      result: "pointer",
    },
    CreateWindowExW: {
      parameters: [
        "u32",
        "buffer",
        "buffer",
        "u32",
        "i32",
        "i32",
        "i32",
        "i32",
        "pointer",
        "pointer",
        "pointer",
        "pointer",
      ],
      result: "pointer",
    },
    DefWindowProcW: {
      parameters: ["pointer", "u32", "usize", "isize"],
      result: "isize",
    },
    DestroyIcon: { parameters: ["pointer"], result: "i32" },
    DestroyMenu: { parameters: ["pointer"], result: "i32" },
    DestroyWindow: { parameters: ["pointer"], result: "i32" },
    DispatchMessageW: { parameters: ["buffer"], result: "isize" },
    GetCursorPos: { parameters: ["buffer"], result: "i32" },
    PeekMessageW: {
      parameters: ["buffer", "pointer", "u32", "u32", "u32"],
      result: "i32",
    },
    PostMessageW: {
      parameters: ["pointer", "u32", "usize", "isize"],
      result: "i32",
    },
    RegisterClassW: { parameters: ["buffer"], result: "u16" },
    RegisterWindowMessageW: { parameters: ["buffer"], result: "u32" },
    SetForegroundWindow: { parameters: ["pointer"], result: "i32" },
    TrackPopupMenu: {
      parameters: ["pointer", "u32", "i32", "i32", "i32", "pointer", "pointer"],
      result: "u32",
    },
    TranslateMessage: { parameters: ["buffer"], result: "i32" },
    UnregisterClassW: {
      parameters: ["buffer", "pointer"],
      result: "i32",
    },
  } as const);
  const shell32 = ffi.dlopen("shell32.dll", {
    Shell_NotifyIconW: {
      parameters: ["u32", "buffer"],
      result: "i32",
    },
  } as const);

  const instance = kernel32.symbols.GetModuleHandleW(null);
  if (instance === null) fail("GetModuleHandleW", kernel32);

  const className = wideString(`RieulGPUiXTrayWindow-${ffi.pid}`);
  const windowTitle = wideString("Rieul tray");
  const taskbarCreated = user32.symbols.RegisterWindowMessageW(
    wideString("TaskbarCreated"),
  );
  let windowHandle: Pointer = null;
  let iconHandle: Pointer = null;
  let destroyed = false;

  const addIcon = () => {
    if (windowHandle === null || iconHandle === null) return false;
    const data = baseNotifyIconData(windowHandle);
    const view = new DataView(data.buffer);
    view.setUint32(FLAGS_OFFSET, NIF_MESSAGE | NIF_ICON | NIF_TIP, true);
    view.setUint32(CALLBACK_MESSAGE_OFFSET, TRAY_CALLBACK_MESSAGE, true);
    view.setBigUint64(ICON_OFFSET, pointerValue(iconHandle), true);
    writeWide(data, TIP_OFFSET, 128, "Rieul");
    if (!shell32.symbols.Shell_NotifyIconW(NIM_ADD, data)) return false;

    const versionData = baseNotifyIconData(windowHandle);
    new DataView(versionData.buffer).setUint32(
      VERSION_OFFSET,
      NOTIFY_ICON_VERSION_4,
      true,
    );
    shell32.symbols.Shell_NotifyIconW(NIM_SETVERSION, versionData);
    return true;
  };

  // Keep WNDPROC native: Windows can re-enter it inside any user32 call.
  // Poll actions after returning to JavaScript instead of re-entering Bun FFI.
  const bridge = ffi.dlopen(
    fileURLToPath(
      new URL("../native/bin/rieul_pairing_windows.dll", import.meta.url),
    ),
    {
      rieul_tray_window_proc: { parameters: ["u32"], result: "pointer" },
      rieul_take_tray_events: { parameters: [], result: "u32" },
    } as const,
  );
  const windowProc = bridge.symbols.rieul_tray_window_proc(taskbarCreated);

  try {
    const windowClass = new Uint8Array(WNDCLASS_SIZE);
    const classView = new DataView(windowClass.buffer);
    classView.setBigUint64(8, pointerValue(windowProc), true);
    classView.setBigUint64(24, pointerValue(instance), true);
    classView.setBigUint64(
      64,
      pointerValue(ffi.UnsafePointer.of(className)),
      true,
    );
    if (!user32.symbols.RegisterClassW(windowClass)) {
      fail("RegisterClassW", kernel32);
    }

    windowHandle = user32.symbols.CreateWindowExW(
      0,
      className,
      windowTitle,
      0,
      0,
      0,
      0,
      0,
      null,
      null,
      instance,
      null,
    );
    if (windowHandle === null) fail("CreateWindowExW", kernel32);

    const iconResource = selectIconResource(options.icon, 32);
    iconHandle = user32.symbols.CreateIconFromResourceEx(
      iconResource,
      iconResource.byteLength,
      1,
      ICON_RESOURCE_VERSION,
      0,
      0,
      0,
    );
    if (iconHandle === null) fail("CreateIconFromResourceEx", kernel32);
    if (!addIcon()) fail("Shell_NotifyIconW(NIM_ADD)", kernel32);
  } catch (error) {
    if (windowHandle !== null) user32.symbols.DestroyWindow(windowHandle);
    if (iconHandle !== null) user32.symbols.DestroyIcon(iconHandle);
    user32.symbols.UnregisterClassW(className, instance);
    bridge.close();
    shell32.close();
    user32.close();
    kernel32.close();
    throw error;
  }

  const message = new Uint8Array(MSG_SIZE);
  const pump = setInterval(() => {
    while (user32.symbols.PeekMessageW(message, null, 0, 0, PM_REMOVE)) {
      user32.symbols.TranslateMessage(message);
      user32.symbols.DispatchMessageW(message);
    }
    const events = bridge.symbols.rieul_take_tray_events();
    if (events & 1) options.onOpen();
    if (events & 2) options.onDaemonInfo();
    if (events & 4) options.onQuit();
    if (events & 8) addIcon();
    if (events & 16) {
      const command = showContextMenu(user32.symbols, windowHandle);
      if (command === MENU_DAEMON_INFO) options.onDaemonInfo();
      if (command === MENU_QUIT) options.onQuit();
    }
  }, 16);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(pump);
      if (windowHandle !== null) {
        shell32.symbols.Shell_NotifyIconW(
          NIM_DELETE,
          baseNotifyIconData(windowHandle),
        );
        user32.symbols.DestroyWindow(windowHandle);
      }
      if (iconHandle !== null) user32.symbols.DestroyIcon(iconHandle);
      user32.symbols.UnregisterClassW(className, instance);
      bridge.close();
      shell32.close();
      user32.close();
      kernel32.close();
    },
    showBalloon(title, body) {
      if (destroyed || windowHandle === null) return;
      const data = baseNotifyIconData(windowHandle);
      const view = new DataView(data.buffer);
      view.setUint32(FLAGS_OFFSET, NIF_INFO | NIF_REALTIME, true);
      writeWide(data, INFO_OFFSET, 256, body);
      writeWide(data, INFO_TITLE_OFFSET, 64, title);
      view.setUint32(INFO_FLAGS_OFFSET, NIIF_INFO, true);
      if (!shell32.symbols.Shell_NotifyIconW(NIM_MODIFY, data)) {
        fail("Shell_NotifyIconW(NIM_MODIFY)", kernel32);
      }
    },
  };
}

function selectIconResource(
  icon: Uint8Array,
  preferredSize: number,
): Uint8Array {
  if (icon.byteLength < 22) throw new Error("ICO file is too short");
  const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength);
  const imageCount = view.getUint16(4, true);
  let selected: { bytes: number; offset: number; score: number } | undefined;
  for (let index = 0; index < imageCount; index++) {
    const entry = 6 + index * 16;
    if (entry + 16 > icon.byteLength) break;
    const width = icon[entry] || 256;
    const height = icon[entry + 1] || 256;
    const bytes = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (offset + bytes > icon.byteLength) continue;
    const score =
      Math.abs(width - preferredSize) + Math.abs(height - preferredSize);
    if (!selected || score < selected.score) {
      selected = { bytes, offset, score };
    }
  }
  if (!selected) throw new Error("ICO file contains no usable images");
  return icon.subarray(selected.offset, selected.offset + selected.bytes);
}

function showContextMenu(
  symbols: {
    AppendMenuW: (
      menu: Pointer,
      flags: number,
      id: bigint,
      label: Pointer,
    ) => number;
    CreatePopupMenu: () => Pointer;
    DestroyMenu: (menu: Pointer) => number;
    GetCursorPos: (point: Int32Array) => number;
    PostMessageW: (
      window: Pointer,
      message: number,
      wParam: bigint,
      lParam: bigint,
    ) => number;
    SetForegroundWindow: (window: Pointer) => number;
    TrackPopupMenu: (
      menu: Pointer,
      flags: number,
      x: number,
      y: number,
      reserved: number,
      window: Pointer,
      rect: Pointer,
    ) => number;
  },
  windowHandle: Pointer,
): number {
  const menu = symbols.CreatePopupMenu();
  if (menu === null) return 0;
  try {
    const daemonInfo = wideString("Daemon info");
    const quit = wideString("Quit");
    symbols.AppendMenuW(
      menu,
      MF_STRING,
      BigInt(MENU_DAEMON_INFO),
      ffi.UnsafePointer.of(daemonInfo),
    );
    symbols.AppendMenuW(menu, MF_SEPARATOR, 0n, null);
    symbols.AppendMenuW(
      menu,
      MF_STRING,
      BigInt(MENU_QUIT),
      ffi.UnsafePointer.of(quit),
    );
    const point = new Int32Array(2);
    if (!symbols.GetCursorPos(point)) return 0;
    symbols.SetForegroundWindow(windowHandle);
    const command = symbols.TrackPopupMenu(
      menu,
      TPM_LEFTALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD,
      point[0]!,
      point[1]!,
      0,
      windowHandle,
      null,
    );
    symbols.PostMessageW(windowHandle, WM_NULL, 0n, 0n);
    return command;
  } finally {
    symbols.DestroyMenu(menu);
  }
}

function baseNotifyIconData(windowHandle: Pointer): Uint8Array {
  const data = new Uint8Array(NOTIFY_ICON_DATA_SIZE);
  const view = new DataView(data.buffer);
  view.setUint32(0, NOTIFY_ICON_DATA_SIZE, true);
  view.setBigUint64(HWND_OFFSET, pointerValue(windowHandle), true);
  view.setUint32(UID_OFFSET, 1, true);
  return data;
}

function pointerValue(pointer: Pointer): bigint {
  return pointer === null ? 0n : ffi.UnsafePointer.value(pointer);
}

function wideString(value: string): Uint8Array {
  const result = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(result.buffer);
  for (let index = 0; index < value.length; index++) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return result;
}

function writeWide(
  target: Uint8Array,
  byteOffset: number,
  capacity: number,
  value: string,
) {
  const view = new DataView(
    target.buffer,
    target.byteOffset,
    target.byteLength,
  );
  const length = Math.min(value.length, capacity - 1);
  for (let index = 0; index < length; index++) {
    view.setUint16(byteOffset + index * 2, value.charCodeAt(index), true);
  }
}

function fail(
  operation: string,
  kernel32: { symbols: { GetLastError(): number } },
): never {
  throw new Error(
    `${operation} failed with Windows error ${kernel32.symbols.GetLastError()}`,
  );
}
