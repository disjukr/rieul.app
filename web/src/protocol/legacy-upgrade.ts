// One-time migration for desktop-0.6.16 (c023ec11). The update wire schema
// is identical in 0.6.17 (2dbee6e1) and 0.6.18 (fd5c421).
// Never add these retired procedures to the current BDL or synthesize ordering.
import { callUnary } from "./client.ts";
import type { CborValue } from "./cbor.ts";
import {
  ProcId,
  UpdatePhase,
  type DaemonInfo,
  type ProcCodec,
} from "./generated/rpc.ts";

export interface LegacyUpdateStatus {
  phase: UpdatePhase;
  currentVersion?: string;
  targetVersion?: string;
  reason?: string;
  canInstall: boolean;
}
export function offersLegacyUpgrade(info: DaemonInfo): boolean {
  // 0.6.16 incorrectly reported its Cargo version in GetDaemonInfo.
  return (
    info.os === "macos" &&
    ["0.1.0", "0.6.16", "0.6.17", "0.6.18"].includes(info.version) &&
    [64, 65].every((id) => info.supportedProcIds.includes(id)) &&
    ![73, 74, 75].some((id) => info.supportedProcIds.includes(id))
  );
}
export function decodeLegacyUpdateStatus(value: CborValue): LegacyUpdateStatus {
  if (!(value instanceof Map) || value.has(6))
    throw new Error("Not a legacy update response");
  const phase = value.get(1),
    canInstall = value.get(5);
  if (
    typeof phase !== "number" ||
    !Number.isInteger(phase) ||
    phase < 0 ||
    phase > 9 ||
    typeof canInstall !== "boolean"
  )
    throw new Error("Invalid legacy update response");
  const fields = value;
  function optionalText(id: number): string | undefined {
    const text = fields.get(id);
    if (text !== undefined && typeof text !== "string")
      throw new Error("Invalid legacy update text");
    return text as string | undefined;
  }
  return {
    phase,
    canInstall,
    currentVersion: optionalText(2),
    targetVersion: optionalText(3),
    reason: optionalText(4),
  };
}
function decodeLegacyError(value: CborValue) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    ![0, 1, 2].includes(value[0] as number) ||
    !(value[1] instanceof Map) ||
    typeof value[1].get(1) !== "string"
  )
    throw new Error("Invalid legacy update error");
  return {
    type: ["failed", "permissionDenied", "confirmationRequired"][
      value[0] as number
    ]!,
    message: value[1].get(1) as string,
  };
}
type Action = "status" | "check" | "install";
export function legacyUpgradeProc(
  action: Action,
): ProcCodec<
  null | undefined,
  LegacyUpdateStatus,
  ReturnType<typeof decodeLegacyError>
> {
  return {
    id: (action === "status" ? 64 : 65) as ProcId,
    name: action === "status" ? "LegacyGetUpdateStatus" : "LegacyRequestUpdate",
    stream: "unary",
    requestType: action === "status" ? "void" : "LegacyRequestUpdateReq",
    responseType: "LegacyUpdateStatus",
    errorType: "LegacyUpdateError",
    encodeRequest: () =>
      action === "status"
        ? null
        : new Map<number, CborValue>([
            [1, action === "check" ? 1 : 2],
            [2, action === "install"],
          ]),
    decodeResponse: decodeLegacyUpdateStatus,
    decodeError: decodeLegacyError,
  };
}
export function legacyUpgrade(transport: WebTransport, action: Action) {
  return callUnary(
    transport,
    legacyUpgradeProc(action),
    action === "status" ? undefined : null,
  );
}

export function isLegacyInstalledVersion(version: string | undefined): boolean {
  return (
    version !== undefined && ["0.6.16", "0.6.17", "0.6.18"].includes(version)
  );
}
