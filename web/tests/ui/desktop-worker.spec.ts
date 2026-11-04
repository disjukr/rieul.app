import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
for (const production of [false, true]) {
  test(`screen worker close cancels transferred streams without consuming shared queue (${production ? "production" : "development"})`, async ({
    page,
  }) => {
    await page.goto("/tests/fixtures/desktop-codec.html");
    const result = await page.evaluate(async () => {
      const modulePath = "/src/protocol/desktop-video-worker-client.ts";
      const { WorkerVideoReceiver } = await import(modulePath);
      let incoming!: ReadableStreamDefaultController<
        ReadableStream<Uint8Array>
      >;
      const streams = new ReadableStream<ReadableStream<Uint8Array>>({
        start(c) {
          incoming = c;
        },
      });
      let cancelled = 0;
      const failures: string[] = [];
      const receiver = new WorkerVideoReceiver(
        { incomingUnidirectionalStreams: streams } as WebTransport,
        "synthetic",
        () => {},
        () => {},
        (m: string) => failures.push(m),
      );
      await receiver.ready;
      receiver.start();
      incoming.enqueue(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 100));
      receiver.close();
      const next = streams.getReader();
      next.releaseLock();
      const until = performance.now() + 1500;
      while (!cancelled && performance.now() < until)
        await new Promise((r) => setTimeout(r, 10));
      return { cancelled, failures };
    });
    expect(result).toEqual({ cancelled: 1, failures: [] });
  });
}
