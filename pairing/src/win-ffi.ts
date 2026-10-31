// Narrow Bun FFI adapter for Rieul's Windows tray implementation.
import { dlopen, ptr, type Pointer as BunPointer } from "bun:ffi";
export type Pointer = BunPointer | null;
type Spec = { parameters: readonly string[]; result: string };
type Arg<T extends string> = T extends "pointer" | "function"
  ? Pointer
  : T extends "buffer"
    ? Parameters<typeof ptr>[0]
    : T extends "usize" | "isize"
      ? bigint
      : number;
type Result<T extends string> = T extends "pointer"
  ? Pointer
  : T extends "void"
    ? void
    : T extends "usize" | "isize"
      ? bigint
      : number;
type Args<T extends readonly string[]> = {
  -readonly [K in keyof T]: Arg<T[K]>;
};
type Symbols<T extends Record<string, Spec>> = {
  [K in keyof T]: (...args: Args<T[K]["parameters"]>) => Result<T[K]["result"]>;
};
const kind = (type: string) =>
  ({
    pointer: "ptr",
    function: "ptr",
    buffer: "ptr",
    usize: "u64",
    isize: "i64",
  })[type] ?? type;
export const ffi = {
  build: { os: process.platform === "win32" ? "windows" : process.platform },
  pid: process.pid,
  UnsafePointer: {
    of: (value: Parameters<typeof ptr>[0]) => ptr(value),
    value: (value: Pointer) => BigInt(value ?? 0),
  },
  dlopen<const T extends Record<string, Spec>>(name: string, specs: T) {
    const definitions = Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [
        name,
        { args: spec.parameters.map(kind), returns: kind(spec.result) },
      ]),
    );
    const library = dlopen(
      name,
      definitions as unknown as Parameters<typeof dlopen>[1],
    );
    const symbols: Record<string, (...args: unknown[]) => unknown> = {};
    for (const [name, spec] of Object.entries(specs)) {
      symbols[name] = (...args: unknown[]) =>
        (library.symbols[name] as unknown as (...args: unknown[]) => unknown)(
          ...args.map((value, i) =>
            spec.parameters[i] === "buffer" && ArrayBuffer.isView(value)
              ? ptr(value as Parameters<typeof ptr>[0])
              : value,
          ),
        );
    }
    return { symbols: symbols as Symbols<T>, close: () => library.close() };
  },
};
