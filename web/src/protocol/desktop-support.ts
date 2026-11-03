import { ProcId } from "./generated/rpc.ts";

/** Procedure discovery is separate from runtime OS permission/driver readiness. */
export function desktopModes(ids: readonly number[]) {
  return {
    existing:
      ids.includes(ProcId.GetDesktopCapabilities) &&
      ids.includes(ProcId.AttachDesktop),
    custom:
      ids.includes(ProcId.GetDesktopLayoutCapabilities) &&
      ids.includes(ProcId.AttachDesktopWithLayout),
  };
}
