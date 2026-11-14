import type { TerminalEvent } from "../../../../protocol/generated/rpc.ts";

type AttachedEvent = Extract<TerminalEvent, { type: "attached" }>;

export interface TerminalAttachControl {
  primaryAttachId: string | undefined;
  fastGrant: boolean;
  refusal?: string;
}

export function terminalAttachControl(
  event: AttachedEvent,
  active: boolean,
): TerminalAttachControl {
  const result = event.controlResult;
  switch (result?.type) {
    case "rejected":
      return {
        primaryAttachId: undefined,
        fastGrant: false,
        refusal: result.error.message || "Terminal control was refused.",
      };
    case "granted":
      if (result.primaryAttachId !== event.attachId || event.primaryAttachId !== event.attachId) {
        return {
          primaryAttachId: undefined,
          fastGrant: false,
          refusal: "The daemon granted control to a different attachment.",
        };
      }
      return {
        primaryAttachId: active ? result.primaryAttachId : undefined,
        fastGrant: true,
      };
    default:
      return {
        // Missing/NotAttempted use the ordinary explicit control RPC.
        primaryAttachId:
          event.primaryAttachId === event.attachId
            ? undefined
            : event.primaryAttachId,
        fastGrant: false,
      };
  }
}

export function allowsTerminalControlRequest(
  control: TerminalAttachControl | undefined,
  active: boolean,
): boolean {
  return active && control?.refusal === undefined;
}

export function allowsNewTerminalInput(
  control: TerminalAttachControl | undefined,
  active: boolean,
): boolean {
  return control?.refusal === undefined && (!control?.fastGrant || active);
}

export function requestTerminalAttachControl(
  control: TerminalAttachControl | undefined,
  active: boolean,
  ownsControl: boolean,
  pending: { current?: Promise<void> },
  request: () => Promise<void>,
): Promise<void> | undefined {
  if (!allowsTerminalControlRequest(control, active)) return;
  // Dedupe acquisition, but do not drop the primary attachment's resizes.
  if (ownsControl) return request();
  if (!pending.current) {
    const promise = request().finally(() => {
      if (pending.current === promise) pending.current = undefined;
    });
    pending.current = promise;
  }
  return pending.current;
}
