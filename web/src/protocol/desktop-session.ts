import { RpcError, rpcErrorCode } from "./client.ts";
import { RpcErrorKind, decodeRpcErrorPayloadValue } from "./generated/wire.ts";
import { encodeCbor, decodeCbor } from "./cbor.ts";
import {
  encodeAttachDesktopReqValue,
  decodeDesktopEventValue,
  decodeDesktopErrorValue,
  ProcId,
  type AttachDesktopReq,
  type DesktopEvent,
} from "./generated/rpc.ts";
import {
  encodeReqResMessageSequence,
  decodeReqResMessageSequencePrefix,
  ReqResMessageKind,
} from "./wire.ts";

/** A bounded, independently cancelable attach stream on the shared connection. */
export async function* desktopEvents(
  transport: WebTransport,
  request: AttachDesktopReq,
  signal: AbortSignal,
  procedure:
    | ProcId.AttachDesktop
    | ProcId.AttachExistingDesktop = ProcId.AttachDesktop,
): AsyncGenerator<DesktopEvent> {
  const stream = await transport.createBidirectionalStream();
  const reader = stream.readable.getReader(),
    writer = stream.writable.getWriter();
  const abort = () => {
    void reader.cancel().catch(() => {});
    void writer.abort().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let started = false;
  try {
    await writer.write(
      encodeReqResMessageSequence([
        {
          kind: ReqResMessageKind.RequestUnary,
          procId: procedure,
          payload: encodeCbor(encodeAttachDesktopReqValue(request)),
        },
      ]),
    );
    await writer.close();
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        if (buffer.length) throw new Error("Truncated screen events");
        break;
      }
      for (let offset = 0; offset < next.value.length; ) {
        const length = Math.min(
          8192,
          next.value.length - offset,
          256 * 1024 - buffer.length,
        );
        if (length <= 0) throw new Error("Screen event exceeds limit");
        const merged = new Uint8Array(buffer.length + length);
        merged.set(buffer);
        merged.set(next.value.subarray(offset, offset + length), buffer.length);
        buffer = merged;
        offset += length;
        const decoded = decodeReqResMessageSequencePrefix(buffer);
        buffer = buffer.slice(decoded.readBytes);
        for (const message of decoded.messages) {
          if (message.kind === ReqResMessageKind.ResponseStreamErrorEnd) {
            if (!message.error)
              throw new RpcError(
                "badMessage",
                "Screen error payload is missing",
              );
            const value = decodeCbor(message.error);
            if (message.errorKind === RpcErrorKind.Method) {
              const error = decodeDesktopErrorValue(value);
              throw new RpcError(error.type, error.message);
            }
            if (message.errorKind === RpcErrorKind.System) {
              const error = decodeRpcErrorPayloadValue(value);
              throw new RpcError(rpcErrorCode(error.code), error.message);
            }
            throw new RpcError("badMessage", "Screen error kind is missing");
          }
          if (
            message.kind !==
              (!started
                ? ReqResMessageKind.ResponseStreamStart
                : ReqResMessageKind.ResponseStreamChunk) ||
            !message.payload
          )
            throw new Error("Invalid screen event stream");
          started = true;
          yield decodeDesktopEventValue(decodeCbor(message.payload));
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    writer.releaseLock();
  }
}
