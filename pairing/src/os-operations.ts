import { spawn } from "node:child_process";
import path from "node:path";
import { dlopen } from "bun:ffi";

export async function openSystemPath(target: string): Promise<void> {
  if (process.platform === "darwin") return run("/usr/bin/open", [target]);
  const library = dlopen("shell32.dll", {
    ShellExecuteW: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr", "i32"],
      returns: "i64",
    },
  });
  try {
    const result = library.symbols.ShellExecuteW(
      null,
      Buffer.from("open\0", "utf16le"),
      Buffer.from(`${target}\0`, "utf16le"),
      null,
      null,
      1,
    );
    if (result <= 32n) throw new Error(`Open config failed (${result})`);
  } finally {
    library.close();
  }
}
export async function copyText(text: string): Promise<void> {
  if (process.platform === "darwin") return run("/usr/bin/pbcopy", [], text);
  return run(
    path.join(
      process.env.SystemRoot ?? "C:/Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ],
    text,
  );
}
async function run(
  executable: string,
  args: string[],
  input?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`System operation failed (${code})`)),
    );
    child.stdin.end(input);
  });
}
