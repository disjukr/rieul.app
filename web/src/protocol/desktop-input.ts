import { encodeCbor, decodeCbor } from "./cbor.ts";
import {
  encodeDesktopInputFrameValue,
  decodeDesktopInputReceiptValue,
  type DesktopInputEvent,
} from "./generated/rpc.ts";
import {
  encodeReqResMessageSequence,
  decodeReqResMessageSequence,
  ReqResMessageKind,
} from "./wire.ts";
import { ProcId } from "./generated/rpc.ts";

/** Browser KeyboardEvent.code -> USB HID keyboard-page usage, never layout text. */
export function desktopKeyUsage(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4;
  if (/^Digit[1-9]$/.test(code)) return Number(code.slice(5)) + 29;
  if (/^F([1-9]|1[0-2])$/.test(code)) return Number(code.slice(1)) + 57;
  if (/^Numpad[1-9]$/.test(code)) return Number(code.slice(6)) + 88;
  return (
    {
      Digit0: 39,
      Enter: 40,
      Escape: 41,
      Backspace: 42,
      Tab: 43,
      Space: 44,
      Minus: 45,
      Equal: 46,
      BracketLeft: 47,
      BracketRight: 48,
      Backslash: 49,
      Semicolon: 51,
      Quote: 52,
      Backquote: 53,
      Comma: 54,
      Period: 55,
      Slash: 56,
      CapsLock: 57,
      PrintScreen: 70,
      ScrollLock: 71,
      Pause: 72,
      Insert: 73,
      Home: 74,
      PageUp: 75,
      Delete: 76,
      End: 77,
      PageDown: 78,
      ArrowRight: 79,
      ArrowLeft: 80,
      ArrowDown: 81,
      ArrowUp: 82,
      NumLock: 83,
      NumpadDivide: 84,
      NumpadMultiply: 85,
      NumpadSubtract: 86,
      NumpadAdd: 87,
      NumpadEnter: 88,
      Numpad0: 98,
      NumpadDecimal: 99,
      IntlBackslash: 100,
      ContextMenu: 101,
      ControlLeft: 224,
      ShiftLeft: 225,
      AltLeft: 226,
      MetaLeft: 227,
      ControlRight: 228,
      ShiftRight: 229,
      AltRight: 230,
      MetaRight: 231,
    } as Record<string, number>
  )[code];
}

export function desktopPoint(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  width: number,
  height: number,
  clientX: number,
  clientY: number,
): { x: number; y: number } | undefined {
  if (!(rect.width > 0 && rect.height > 0 && width > 0 && height > 0)) return;
  const x = ((clientX - rect.left) * width) / rect.width,
    y = ((clientY - rect.top) * height) / rect.height;
  if (![x, y].every(Number.isFinite)) return;
  return {
    x: Math.max(0, Math.min(width - 0.001, x)),
    y: Math.max(0, Math.min(height - 0.001, y)),
  };
}

const FRAME_LIMIT = 16 * 1024;
const ROLLOVER_LIMIT = 7 * 1024 * 1024;
const QUEUE_LIMIT = 128;
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Desktop input timed out")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
interface InputStream {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  bytes: number;
  lastSequence: number;
  started: boolean;
}
/** One ordered channel per attachment. Never replays uncertain input after failure. */
export class DesktopInputChannel {
  private tail = Promise.resolve();
  private pending = 0;
  private sequence = 0;
  private stream?: InputStream;
  private closed = false;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(
    private transport: WebTransport,
    private attachId: string,
    private epochs: () => { inputEpoch: number; layoutEpoch: number },
    private failed: (error: Error) => void,
  ) {}
  send(event: DesktopInputEvent): boolean {
    if (this.closed) return false;
    if (this.pending >= QUEUE_LIMIT) {
      this.fail(
        new Error(
          "Input queue full; control released. Reconnect before continuing.",
        ),
      );
      return false;
    }
    clearTimeout(this.idle);
    const epochs = this.epochs();
    this.pending++;
    this.tail = this.tail
      .then(async () => {
        if (this.closed) return;
        if (this.stream && this.stream.bytes >= ROLLOVER_LIMIT)
          await this.finish();
        if (!this.stream) {
          const stream = await deadline(
            this.transport.createBidirectionalStream().then((stream) => {
              if (this.closed) {
                void stream.writable.abort().catch(() => {});
                void stream.readable.cancel().catch(() => {});
                throw new Error("Desktop input closed");
              }
              return stream;
            }),
          );
          if (this.closed) {
            void stream.writable.abort();
            void stream.readable.cancel();
            return;
          }
          this.stream = {
            writer: stream.writable.getWriter(),
            reader: stream.readable.getReader(),
            bytes: 0,
            lastSequence: 0,
            started: false,
          };
        }
        const stream = this.stream;
        const payload = encodeCbor(
          encodeDesktopInputFrameValue({
            attachId: this.attachId,
            ...epochs,
            sequence: ++this.sequence,
            event,
          }),
        );
        if (payload.length > FRAME_LIMIT)
          throw new Error("Input frame exceeds negotiated limit");
        const bytes = encodeReqResMessageSequence([
          stream.started
            ? { kind: ReqResMessageKind.RequestStreamChunk, payload }
            : {
                kind: ReqResMessageKind.RequestStreamStart,
                procId: ProcId.WriteDesktopInput,
                payload,
              },
        ]);
        await deadline(stream.writer.write(bytes));
        stream.started = true;
        stream.bytes += bytes.length;
        stream.lastSequence = this.sequence;
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        this.pending--;
        if (!this.closed && this.pending === 0)
          this.idle = setTimeout(() => this.flush(), 500);
      });
    return true;
  }
  /** Clean half-close preserves held input while avoiding an idle stream timeout. */
  flush(): Promise<void> {
    clearTimeout(this.idle);
    this.tail = this.tail
      .then(() => this.finish())
      .catch((error) => this.fail(error));
    return this.tail;
  }
  private async finish(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    await deadline(stream.writer.close());
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await deadline(stream.reader.read());
      if (next.done) break;
      size += next.value.length;
      if (size > FRAME_LIMIT) throw new Error("Input receipt exceeds limit");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const messages = decodeReqResMessageSequence(bytes);
    const response = messages[0];
    if (
      messages.length !== 1 ||
      response?.kind !== ReqResMessageKind.ResponseUnaryOk ||
      !response.payload
    )
      throw new Error(
        "Desktop input was rejected; reconnect before continuing.",
      );
    const receipt = decodeDesktopInputReceiptValue(
      decodeCbor(response.payload),
    );
    if (receipt.lastSequence !== stream.lastSequence)
      throw new Error("Unexpected desktop input receipt");
    stream.writer.releaseLock();
    stream.reader.releaseLock();
    if (this.stream === stream) this.stream = undefined;
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.abort();
    this.failed(error instanceof Error ? error : new Error(String(error)));
  }
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    const stream = this.stream;
    this.stream = undefined;
    if (stream) {
      void stream.writer.abort().catch(() => {});
      void stream.reader.cancel().catch(() => {});
    }
  }
}

export function bindDesktopInput(
  canvas: HTMLCanvasElement,
  viewportId: string,
  send: (event: DesktopInputEvent) => boolean,
  control: () => { active: boolean; epoch: number },
): () => void {
  const keys = new Set<number>();
  let epoch = control().epoch;
  const active = () => {
    const state = control();
    if (state.epoch !== epoch) {
      keys.clear();
      epoch = state.epoch;
    }
    return state.active;
  };
  const release = () => {
    keys.clear();
    if (active()) send({ type: "releaseAll" });
  };
  const point = (e: MouseEvent) =>
    desktopPoint(
      canvas.getBoundingClientRect(),
      canvas.width,
      canvas.height,
      e.clientX,
      e.clientY,
    );
  const key = (e: KeyboardEvent) => {
    if (!active() || e.isComposing) return;
    if (e.type === "keydown" && e.code === "Escape" && e.ctrlKey && e.altKey) {
      e.preventDefault();
      release();
      canvas.blur();
      return;
    }
    const usage = desktopKeyUsage(e.code);
    if (usage === undefined) return;
    e.preventDefault();
    if (e.type === "keydown") {
      if (e.repeat && !keys.has(usage)) return;
      keys.add(usage);
      send({ type: "physicalKey", usage, down: true, repeat: e.repeat });
    } else {
      keys.delete(usage);
      send({ type: "physicalKey", usage, down: false, repeat: false });
    }
  };
  const button = (e: PointerEvent) => {
    if (!active()) return;
    const p = point(e);
    const mapped = [1, 3, 2, 4, 5][e.button];
    if (!p || mapped === undefined) return;
    e.preventDefault();
    if (e.type === "pointerdown") {
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
    }
    send({
      type: "button",
      viewportId,
      ...p,
      button: mapped,
      down: e.type === "pointerdown",
    });
    if (e.type === "pointerup" && canvas.hasPointerCapture(e.pointerId))
      canvas.releasePointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!active()) return;
    const samples =
      e.buttons && e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [e]) {
      const p = point(sample);
      if (p && !send({ type: "absolutePointer", viewportId, ...p })) break;
    }
  };
  const wheel = (e: WheelEvent) => {
    if (!active()) return;
    const p = point(e);
    if (!p) return;
    e.preventDefault();
    send({
      type: "wheel",
      viewportId,
      ...p,
      dx: e.deltaX,
      dy: e.deltaY,
      unit: e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 2 : 0,
    });
  };
  const context = (e: MouseEvent) => {
    if (active()) e.preventDefault();
  };
  const win = canvas.ownerDocument.defaultView;
  const visibility = () => {
    if (canvas.ownerDocument.hidden) release();
  };
  canvas.addEventListener("keydown", key);
  canvas.addEventListener("keyup", key);
  canvas.addEventListener("pointerdown", button);
  canvas.addEventListener("pointerup", button);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("blur", release);
  canvas.addEventListener("compositionstart", release);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("contextmenu", context);
  win?.addEventListener("blur", release);
  canvas.ownerDocument.addEventListener("visibilitychange", visibility);
  return () => {
    release();
    canvas.removeEventListener("keydown", key);
    canvas.removeEventListener("keyup", key);
    canvas.removeEventListener("pointerdown", button);
    canvas.removeEventListener("pointerup", button);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointercancel", release);
    canvas.removeEventListener("blur", release);
    canvas.removeEventListener("compositionstart", release);
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("contextmenu", context);
    win?.removeEventListener("blur", release);
    canvas.ownerDocument.removeEventListener("visibilitychange", visibility);
  };
}
