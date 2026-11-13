// Each queue belongs to exactly one attachment/control epoch. Uncertain input
// is discarded rather than replayed into a newly attached shell.
const MAX_PENDING_BYTES = 256 * 1024;
const CHUNK_BYTES = 16 * 1024;

export class TerminalInputStream {
  private chunks: Uint8Array[] = [];
  private pendingBytes = 0;
  private wake?: () => void;
  private closed = false;

  enqueue(bytes: Uint8Array): boolean {
    if (this.closed || this.pendingBytes + bytes.length > MAX_PENDING_BYTES) {
      return false;
    }
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      this.chunks.push(bytes.slice(offset, offset + CHUNK_BYTES));
    }
    this.pendingBytes += bytes.length;
    this.wake?.();
    return true;
  }

  close() {
    this.closed = true;
    this.chunks = [];
    this.pendingBytes = 0;
    this.wake?.();
  }

  async *read(): AsyncGenerator<Uint8Array> {
    while (!this.closed) {
      const chunk = this.chunks.shift();
      if (chunk) {
        this.pendingBytes -= chunk.length;
        yield chunk;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    }
  }
}
