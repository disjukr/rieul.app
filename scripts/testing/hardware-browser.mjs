// Synthetic localhost servers only. No host trust, capture, pairing or input.
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const fixture = JSON.parse(await readFile(process.argv[2], "utf8"));
const url = "http://127.0.0.1:5193";
const vite = spawn(
  "pnpm",
  [
    "--dir",
    "web",
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    "5193",
    "--strictPort",
  ],
  {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: "ignore",
    detached: true,
  },
);
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    executablePath:
      process.env.RIEUL_TEST_CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(e));
  await page.goto(url);
  const result = await page.evaluate(async (fixture) => {
    const { authenticateWebTransport } = await import(
      "/src/protocol/client.ts"
    );
    const rpc = await import("/src/protocol/generated/client.ts");
    const { ProcId, DesktopKeyboardMode, DesktopControlAction } = await import(
      "/src/protocol/generated/rpc.ts"
    );
    const { desktopEvents } = await import("/src/protocol/desktop-session.ts");
    const { DesktopVideoReceiver, supportedDesktopCodecs } = await import(
      "/src/protocol/desktop-video.ts"
    );
    const { DesktopInputChannel } = await import(
      "/src/protocol/desktop-input.ts"
    );
    const transport = new WebTransport(fixture.url, {
      serverCertificateHashes: [
        {
          algorithm: "sha-256",
          value: Uint8Array.from(fixture.hash.match(/../g), (x) =>
            parseInt(x, 16),
          ),
        },
      ],
    });
    await transport.ready;
    // No anonymous capability access even though this test uses only generated pixels.
    let denied = false;
    try {
      await rpc.getDesktopCapabilities(transport);
    } catch {
      denied = true;
    }
    if (!denied) throw new Error("unauthenticated screen access");
    await authenticateWebTransport(transport, fixture.clientId, fixture.secret);
    const caps = await rpc.getDesktopCapabilities(transport);
    if (caps.codecs.length !== 1 || !caps.codecs[0].hardware)
      throw new Error("hardware fixture capability mismatch");
    const codecs = await supportedDesktopCodecs(caps.codecs);
    if (!codecs.length) throw new Error("fixture H264 unsupported");
    const abort = new AbortController();
    const events = desktopEvents(
      transport,
      {
        profile: fixture.stripes ? 2 : 1,
        codecs,
        mediaUniStreams: true,
        keyboardMode: DesktopKeyboardMode.Physical,
      },
      abort.signal,
      ProcId.AttachExistingDesktop,
    );
    let receiver, input, configuration, attachId, control;
    let streamsSeen = 0,
      cancelledStreams = 0;
    const media = {
      incomingUnidirectionalStreams:
        transport.incomingUnidirectionalStreams.pipeThrough(
          new TransformStream({
            transform(stream, controller) {
              if (++streamsSeen === 3) {
                cancelledStreams++;
                void stream.cancel();
                return;
              }
              controller.enqueue(stream);
            },
          }),
        ),
    };
    const frames = {},
      pixels = {},
      bottomPixels = {},
      errors = [],
      groups = new Set();
    let feedback = 0;
    let receiptsHeld = 0,
      holdUntil = 0,
      maxObject = 0;
    const heldGroups = new Set(),
      recoveredGroups = new Set();
    const frameGoal = fixture.continuous ? 40 : 8;
    let refreshRequested = false;
    const started = performance.now();
    const firstFrameMs = {};
    for (;;) {
      const next = await events.next();
      if (next.done) throw new Error("attach ended");
      const e = next.value;
      if (e.type === "attached") {
        attachId = e.attachId;
        control = await rpc.setDesktopControl(transport, {
          attachId,
          action: DesktopControlAction.Acquire,
        });
        input = new DesktopInputChannel(
          transport,
          attachId,
          () => ({
            inputEpoch: control.inputEpoch,
            layoutEpoch: configuration.layoutEpoch,
          }),
          (e) => errors.push(String(e)),
        );
        receiver = new DesktopVideoReceiver(
          media,
          attachId,
          (id, frame) => {
            const canvas = document.createElement("canvas");
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
            const context = canvas.getContext("2d");
            context.drawImage(frame, 0, 0);
            (pixels[id] ??= []).push(
              context.getImageData(10, 10, 1, 1).data[0],
            );
            (bottomPixels[id] ??= []).push(
              context.getImageData(10, canvas.height - 10, 1, 1).data[0],
            );
            frames[id] = (frames[id] ?? 0) + 1;
            firstFrameMs[id] ??= performance.now() - started;
          },
          (stats) => {
            const group = `${stats.trackId}:${stats.groupId}`;
            groups.add(group);
            maxObject = Math.max(maxObject, stats.objectId ?? 0);
            if (
              holdUntil &&
              performance.now() >= holdUntil &&
              !heldGroups.has(group)
            )
              recoveredGroups.add(group);
            if (fixture.continuous && feedback >= 16 && holdUntil === 0)
              holdUntil = performance.now() + 500;
            if (performance.now() < holdUntil) {
              receiptsHeld++;
              heldGroups.add(group);
              return;
            }
            if (input.send({ type: "feedback", ...stats })) feedback++;
            if (!refreshRequested && feedback >= 8) {
              refreshRequested = true;
              input.send({
                type: "feedback",
                ...stats,
                objectId: undefined,
                requestKeyframe: true,
              });
            }
          },
          (e) => errors.push(e),
        );
      } else if (e.type === "configured") {
        configuration = e.configuration;
        await receiver.configure(configuration);
        break;
      }
    }
    if (configuration.tracks.length !== 2)
      throw new Error("missing independent display tracks");
    input.send({ type: "physicalKey", usage: 225, down: true, repeat: false });
    const until = performance.now() + 15000;
    while (
      performance.now() < until &&
      (Object.keys(frames).length !== 2 ||
        Object.values(frames).some((n) => n < frameGoal))
    ) {
      if (errors.length) throw new Error(errors.join(";"));
      await new Promise((r) => setTimeout(r, 20));
    }
    // Allow reliable feedback/input to reach the fixture before abrupt disconnect.
    await new Promise((r) => setTimeout(r, 150));
    const result = {
      frames,
      receiptsHeld,
      maxObject,
      recoveredGroups: recoveredGroups.size,
      firstFrameMs,
      pixels,
      bottomPixels,
      groups: groups.size,
      cancelledStreams,
      feedback,
      errors,
      codecs,
    };
    receiver.close();
    transport.close();
    abort.abort();
    return result;
  }, fixture);
  assert.equal(Object.keys(result.frames).length, 2, JSON.stringify(result));
  for (const count of Object.values(result.frames))
    assert.ok(count >= (fixture.continuous ? 40 : 8), JSON.stringify(result));
  for (const p of Object.values(result.pixels))
    assert.ok(
      Math.max(...p) < (fixture.stripes ? 70 : 8),
      JSON.stringify(result),
    );
  if (fixture.stripes)
    for (const p of Object.values(result.bottomPixels))
      assert.ok(Math.min(...p) > 150, JSON.stringify(result));
  console.log(
    JSON.stringify({
      firstFrameMs: result.firstFrameMs,
      frames: result.frames,
      feedback: result.feedback,
      maxObject: result.maxObject,
      receiptsHeld: result.receiptsHeld,
      recoveredGroups: result.recoveredGroups,
      groups: result.groups,
    }),
  );
  if (fixture.continuous) {
    assert.ok(result.receiptsHeld > 0);
    assert.ok(result.maxObject > 10, JSON.stringify(result));
    assert.ok(result.recoveredGroups > 0, JSON.stringify(result));
  }
  assert.ok(result.feedback >= 16);
  assert.ok(result.groups >= 4);
  assert.equal(result.cancelledStreams, 1);
  assert.deepEqual(result.errors, []);
  console.log(
    "PASS: pre-encoded VideoToolbox synthetic GOP → incremental helper IPC → authenticated WebTransport → Chrome; two independent displays, fresh GOPs, render feedback, requested refresh, disconnect held-key cleanup checked by Rust fixture",
  );
} finally {
  await browser?.close();
  try {
    process.kill(-vite.pid, "SIGTERM");
  } catch {}
}
