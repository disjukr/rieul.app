const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x10;
const WM_SETICON = 0x80;
const GWL_STYLE = -16;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_MINIMIZEBOX = 0x00020000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

export interface WindowsCloseGuard {
  destroy(): void;
  install(): number;
}

export function createWindowsCloseGuard(
  libraryPath: string,
  onClose: () => void,
): WindowsCloseGuard | undefined {
  if (Deno.build.os !== "windows") return undefined;

  const guard = Deno.dlopen(
    libraryPath,
    {
      rieul_install_close_guard: {
        parameters: ["pointer"],
        result: "i32",
      },
      rieul_take_close_requests: {
        parameters: [],
        result: "u32",
      },
      rieul_uninstall_close_guard: {
        parameters: [],
        result: "void",
      },
    } as const,
  );
  const user32 = Deno.dlopen(
    "user32.dll",
    {
      EnumWindows: {
        parameters: ["function", "pointer"],
        result: "i32",
      },
      GetWindowRect: {
        parameters: ["pointer", "buffer"],
        result: "i32",
      },
      GetWindowThreadProcessId: {
        parameters: ["pointer", "buffer"],
        result: "u32",
      },
      IsWindowVisible: {
        parameters: ["pointer"],
        result: "i32",
      },
    } as const,
  );
  const closePoll = setInterval(() => {
    if (guard.symbols.rieul_take_close_requests() > 0) onClose();
  }, 50);

  function install(): number {
    let candidate: Deno.PointerValue = null;
    const callback = new Deno.UnsafeCallback(
      { parameters: ["pointer", "pointer"], result: "i32" },
      (windowHandle) => {
        const processId = new Uint32Array(1);
        user32.symbols.GetWindowThreadProcessId(windowHandle, processId);
        if (
          processId[0] !== Deno.pid ||
          !user32.symbols.IsWindowVisible(windowHandle)
        ) {
          return 1;
        }

        const rect = new Int32Array(4);
        if (!user32.symbols.GetWindowRect(windowHandle, rect)) return 1;
        const width = rect[2]! - rect[0]!;
        const height = rect[3]! - rect[1]!;
        if (width < 300 || height < 200) return 1;

        candidate = windowHandle;
        return 0;
      },
    );
    try {
      user32.symbols.EnumWindows(callback.pointer, null);
    } finally {
      callback.close();
    }
    return candidate === null
      ? 0
      : guard.symbols.rieul_install_close_guard(candidate);
  }

  function destroy() {
    clearInterval(closePoll);
    guard.symbols.rieul_uninstall_close_guard();
    user32.close();
    guard.close();
  }

  return { destroy, install };
}

export function applyWindowsWindowIcon(iconPath: string): number {
  if (Deno.build.os !== "windows") return 0;

  const user32 = Deno.dlopen(
    "user32.dll",
    {
      EnumWindows: {
        parameters: ["function", "pointer"],
        result: "i32",
      },
      GetWindowThreadProcessId: {
        parameters: ["pointer", "buffer"],
        result: "u32",
      },
      LoadImageW: {
        parameters: ["pointer", "buffer", "u32", "i32", "i32", "u32"],
        result: "pointer",
      },
      SendMessageW: {
        parameters: ["pointer", "u32", "usize", "pointer"],
        result: "isize",
      },
    } as const,
  );

  const path = toWideString(iconPath);
  const smallIcon = user32.symbols.LoadImageW(
    null,
    path,
    IMAGE_ICON,
    16,
    16,
    LR_LOADFROMFILE,
  );
  const largeIcon = user32.symbols.LoadImageW(
    null,
    path,
    IMAGE_ICON,
    32,
    32,
    LR_LOADFROMFILE,
  );
  if (!smallIcon || !largeIcon) {
    user32.close();
    throw new Error(`failed to load window icon: ${iconPath}`);
  }

  let appliedWindowCount = 0;
  const callback = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "i32" },
    (windowHandle) => {
      const processId = new Uint32Array(1);
      user32.symbols.GetWindowThreadProcessId(windowHandle, processId);
      if (processId[0] === Deno.pid) {
        user32.symbols.SendMessageW(windowHandle, WM_SETICON, 0n, smallIcon);
        user32.symbols.SendMessageW(windowHandle, WM_SETICON, 1n, largeIcon);
        appliedWindowCount++;
      }
      return 1;
    },
  );

  try {
    user32.symbols.EnumWindows(callback.pointer, null);
  } finally {
    callback.close();
    user32.close();
  }
  return appliedWindowCount;
}

export function removeWindowsMinimizeMaximizeButtons(): number {
  if (Deno.build.os !== "windows") return 0;

  const user32 = Deno.dlopen(
    "user32.dll",
    {
      EnumWindows: {
        parameters: ["function", "pointer"],
        result: "i32",
      },
      GetWindowLongW: {
        parameters: ["pointer", "i32"],
        result: "i32",
      },
      GetWindowThreadProcessId: {
        parameters: ["pointer", "buffer"],
        result: "u32",
      },
      SetWindowLongW: {
        parameters: ["pointer", "i32", "i32"],
        result: "i32",
      },
      SetWindowPos: {
        parameters: [
          "pointer",
          "pointer",
          "i32",
          "i32",
          "i32",
          "i32",
          "u32",
        ],
        result: "i32",
      },
    } as const,
  );

  let appliedWindowCount = 0;
  const callback = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "i32" },
    (windowHandle) => {
      const processId = new Uint32Array(1);
      user32.symbols.GetWindowThreadProcessId(windowHandle, processId);
      if (processId[0] !== Deno.pid) return 1;

      const style = user32.symbols.GetWindowLongW(windowHandle, GWL_STYLE);
      const nextStyle = style & ~(WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
      if (nextStyle !== style) {
        user32.symbols.SetWindowLongW(windowHandle, GWL_STYLE, nextStyle);
        user32.symbols.SetWindowPos(
          windowHandle,
          null,
          0,
          0,
          0,
          0,
          SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE |
            SWP_FRAMECHANGED,
        );
        appliedWindowCount++;
      }
      return 1;
    },
  );

  try {
    user32.symbols.EnumWindows(callback.pointer, null);
  } finally {
    callback.close();
    user32.close();
  }
  return appliedWindowCount;
}

function toWideString(value: string): Uint16Array {
  const result = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++) {
    result[index] = value.charCodeAt(index);
  }
  return result;
}
