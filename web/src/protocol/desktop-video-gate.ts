export class DesktopMediaGate {
  readonly streams: ReadableStream<ReadableStream<Uint8Array>>;
  private reader: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>;
  private paused = true;
  private closed = false;
  private revision = 0;
  private wake!: () => void;
  private resumed = new Promise<void>((resolve) => {
    this.wake = resolve;
  });

  constructor(source: ReadableStream<ReadableStream<Uint8Array>>) {
    this.reader = source.getReader();
    this.streams = new ReadableStream(
      {
        pull: async (controller) => {
          await this.wait();
          if (this.closed) {
            controller.close();
            return;
          }
          const next = await this.reader.read();
          await this.wait();
          if (this.closed) {
            if (!next.done) await next.value.cancel().catch(() => {});
            controller.close();
          } else if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: () => this.close(),
      },
      { highWaterMark: 0 },
    );
  }
  private async wait() {
    while (this.paused && !this.closed) await this.resumed;
  }
  prepare(): number {
    const revision = ++this.revision;
    if (!this.paused) {
      this.paused = true;
      this.resumed = new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    return revision;
  }
  current(revision: number): boolean {
    return !this.closed && revision === this.revision;
  }
  release(revision: number) {
    if (!this.current(revision)) return;
    this.paused = false;
    this.wake();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    void this.reader
      .cancel()
      .catch(() => {})
      .finally(() => this.reader.releaseLock());
  }
}
