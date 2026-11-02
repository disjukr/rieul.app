import { test } from "node:test";
import assert from "node:assert/strict";
import { openWebTransport } from "../src/protocol/client.ts";

for (const failure of [
  "ready rejection",
  "closed before ready",
  "timeout",
  "cancel",
] as const) {
  test(`opening transport handles ${failure} and closes the failed attempt`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ready = Promise.withResolvers<void>(),
      closed = Promise.withResolvers<WebTransportCloseInfo>();
    let closes = 0;
    class Fake {
      ready = ready.promise;
      closed = closed.promise;
      close() {
        closes++;
        closed.reject(new Error("closed while opening"));
      }
    }
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "WebTransport",
    );
    Object.defineProperty(globalThis, "WebTransport", {
      configurable: true,
      value: Fake,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, "WebTransport", previous);
      else Reflect.deleteProperty(globalThis, "WebTransport");
    });
    const abort = new AbortController();
    const result = openWebTransport(
      { id: "test", name: "fixture", baseUrl: "https://fixture.invalid" },
      undefined,
      abort.signal,
    );
    const rejected = assert.rejects(result);
    if (failure === "ready rejection") {
      ready.reject(new Error("refused"));
      closed.reject(new Error("refused"));
    }
    if (failure === "closed before ready") closed.resolve({});
    if (failure === "timeout") t.mock.timers.tick(10_000);
    if (failure === "cancel") abort.abort();
    await rejected;
    assert.equal(closes, 1);
    ready.resolve();
    await Promise.resolve();
    assert.equal(closes, 1);
  });
}
