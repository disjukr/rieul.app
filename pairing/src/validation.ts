import { decodeCbor, type CborValue } from "../../web/src/protocol/cbor.ts";
import * as ipc from "../../web/src/protocol/socket-ipc.ts";

/** Validate before calling the shared defaulting decoders or mutating request state.
 * Missing required defaults are unsafe for methods that replace a pairing prompt.
 * Unknown numeric fields remain accepted per rieul-cbor forward compatibility.
 */
export function validateGuiPayload(procId: number, payload: Uint8Array): void {
  if (procId === ipc.IPC_PROC_PAIRING_COMPLETED) {
    if (payload.length)
      throw new Error("PairingCompleted requires a void payload");
    return;
  }
  const fieldsByProc: Record<number, readonly number[]> = {
    [ipc.IPC_PROC_SHOW_PAIRING_CODE]: [1, 2, 3],
    [ipc.IPC_PROC_CONFIRM_PAIRING]: [1, 2, 3],
    [ipc.IPC_PROC_SHOW_DAEMON_INFO]: [1, 2],
    [ipc.IPC_PROC_ACTIVATE_GUI]: [1],
  };
  const required = fieldsByProc[procId];
  if (!required) throw new Error(`unsupported GUI IPC proc id ${procId}`);
  const map = decodeCbor(payload);
  if (!(map instanceof Map)) throw new Error("GUI request must be a CBOR map");
  for (const id of required) {
    if (!map.has(id)) throw new Error(`required GUI field ${id} is missing`);
    const value = map.get(id);
    if (procId === ipc.IPC_PROC_SHOW_PAIRING_CODE && id === 3) {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        throw new Error("expiresInSeconds must be u53");
    } else if (typeof value !== "string") {
      throw new Error(`required GUI field ${id} must be text`);
    }
  }
  if (
    procId === ipc.IPC_PROC_SHOW_PAIRING_CODE ||
    procId === ipc.IPC_PROC_CONFIRM_PAIRING
  ) {
    requireDaemonUrl(map.get(1));
    const digits = procId === ipc.IPC_PROC_SHOW_PAIRING_CODE ? 6 : 2;
    const code = map.get(2) as string;
    if (
      code.length !== digits ||
      [...code].some((char) => char < "0" || char > "9")
    )
      throw new Error(`pairing code must be ${digits} ASCII digits`);
  }
  // Empty info values deliberately retain the existing config/URL fallback behavior.
  if (procId === ipc.IPC_PROC_SHOW_DAEMON_INFO && map.get(2) !== "")
    requireDaemonUrl(map.get(2));
}

function requireDaemonUrl(value: CborValue | undefined): void {
  if (
    typeof value !== "string" ||
    !/^https:\/\//i.test(value) ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    throw new Error("daemonUrl must be an absolute HTTPS URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new Error("daemonUrl must be an absolute HTTPS URL without userinfo");
}
