import type { CborValue } from "./cbor.ts";
import { callUnary } from "./client.ts";
import {
  checkForUpdatesProc as checkProc,
  installUpdateConfirmedProc as installProc,
  subscribeUpdateStatusProc as subscribeProc,
  decodeUpdateStatusValue,
  type UpdateStatus,
} from "./generated/rpc.ts";

// BDL's general codecs default absent fields. This profile requires explicit
// ordering on the wire; never mistake a legacy/defaulted response for epoch 0.
export function decodeOrderedUpdateStatus(value: CborValue): UpdateStatus {
  const ordering = value instanceof Map ? value.get(6) : undefined;
  if (!(ordering instanceof Map) || !ordering.has(1) || !ordering.has(2)) {
    throw new Error("Update status requires explicit epoch and revision");
  }
  const status = decodeUpdateStatusValue(value);
  if (
    !status.ordering.epoch ||
    !Number.isSafeInteger(status.ordering.revision) ||
    status.ordering.revision < 0
  ) {
    throw new Error("Invalid update status ordering");
  }
  return status;
}
const checkedCheckProc = {
  ...checkProc,
  decodeResponse: decodeOrderedUpdateStatus,
};
const checkedInstallProc = {
  ...installProc,
  decodeResponse: decodeOrderedUpdateStatus,
};
export const subscribeUpdateStatusProc = {
  ...subscribeProc,
  decodeResponse: decodeOrderedUpdateStatus,
};
export function checkForUpdates(transport: WebTransport) {
  return callUnary(transport, checkedCheckProc, undefined);
}
export function installUpdateConfirmed(transport: WebTransport) {
  return callUnary(transport, checkedInstallProc, undefined);
}
