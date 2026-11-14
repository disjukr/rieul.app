import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const origin = "http://127.0.0.1:5193";
const fixturePage = `${origin}/__hosted-screen-browser-fixture`;
const warmup = 5;
const measured = 40;
const deadlineMs = 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function observeScroll(fixture) {
  const width = 640;
  const height = 480;
  const { authenticateWebTransport, RpcError } = await import(
    "/src/protocol/client.ts"
  );
  const rpc = await import("/src/protocol/generated/client.ts");
  const {
    ProcId,
    DesktopKeyboardMode,
    DesktopControlAction,
    DesktopWheelUnit,
  } = await import("/src/protocol/generated/rpc.ts");
  const { desktopEvents } = await import("/src/protocol/desktop-session.ts");
  const { DesktopVideoReceiver, supportedDesktopCodecs } = await import(
    "/src/protocol/desktop-video.ts"
  );
  const { DesktopInputChannel } = await import(
    "/src/protocol/desktop-input.ts"
  );

  const abort = new AbortController();
  const results = [];
  const decodeMicros = [];
  const renderMicros = [];
  const counts = {
    canvasDraws: 0,
    duplicateMarkerDraws: 0,
    staleMarkerDraws: 0,
    invalidMarkerDraws: 0,
    futureMarkerDraws: 0,
    actionTimeouts: 0,
    sendFailures: 0,
    receiverFailures: 0,
    inputFailures: 0,
    codecFailures: 0,
    keyframeRequests: 0,
    feedbackAccepted: 0,
    maxReceiverQueueDepth: 0,
    tappedStreams: 0,
    browserTappedMediaBytes: 0,
  };
  let transport, receiver, input, events, configuration, leaseTimer;
  let operational = true;
  let stage = "transport";
  let failure = null;
  let codec = null;
  let firstFrameMs = null;
  let displayed = null;
  let pending = null;
  let raf = 0;
  let expected = 0;
  let stopping;
  const stopped = new Promise((resolve) => (stopping = resolve));
  const stop = (reason) => {
    if (!operational) return;
    failure = reason;
    operational = false;
    stopping();
  };
  const started = performance.now();
  const deadline = setTimeout(
    () => stop("browser_observation_deadline"),
    fixture.deadlineMs,
  );

  function readMarker(context) {
    const row = context.getImageData(64, 336, 512, 1).data;
    let signature = 0;
    for (let tile = 0; tile < 32; tile++) {
      const offset = (tile * 16 + 8) * 4;
      const r = row[offset];
      const g = row[offset + 1];
      const b = row[offset + 2];
      const black = Math.max(r, g, b) < 60;
      const white = Math.min(r, g, b) > 195;
      if (!black && !white) return null;
      signature = ((signature << 1) | Number(white)) >>> 0;
    }
    const id = (signature >>> 8) & 0xff;
    return signature >>> 16 === 0xa5c3 && (signature & 0xff) === (id ^ 0xff)
      ? id
      : null;
  }

  function rank(values) {
    const ascending = values.toSorted((a, b) => a - b);
    const percentile = (q) =>
      ascending[Math.ceil(q * ascending.length) - 1] ?? null;
    return {
      count: ascending.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
    };
  }

  function waitForMarker(id, start, send) {
    expected = id;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          if (id !== 0) counts.actionTimeouts++;
          stop(id === 0 ? "initial_marker_timeout" : "scroll_marker_timeout");
        },
        id === 0 ? 8000 : 4000,
      );
      pending = { id, start, resolve, timer };
      if (send && !send()) {
        counts.sendFailures++;
        stop("scroll_not_queued");
      }
    });
  }

  function afterDraw(canvas) {
    if (raf || !pending || displayed.id !== pending.id) return;
    // Two callbacks span one rendering opportunity; they do not attest scanout.
    raf = requestAnimationFrame(() => {
      if (!operational || !pending || displayed?.id !== pending.id) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (
          !operational ||
          !canvas.isConnected ||
          !pending ||
          displayed?.id !== pending.id
        )
          return;
        const { id, start, resolve, timer } = pending;
        clearTimeout(timer);
        pending = null;
        resolve({
          id,
          actionToCanvasRafMs: performance.now() - start,
          frameTimestampMicros: displayed.timestampMicros,
        });
      });
    });
  }

  async function run() {
    transport = new WebTransport(fixture.url, {
      serverCertificateHashes: [
        {
          algorithm: "sha-256",
          value: Uint8Array.from(fixture.hash.match(/../g), (x) =>
            parseInt(x, 16),
          ),
        },
      ],
    });
    void transport.closed.then(
      () => stop("unexpected_transport_close"),
      () => stop("transport_error"),
    );
    await transport.ready;
    if (!operational) return;
    stage = "auth_gate";
    let denied = false;
    try {
      await rpc.getDesktopCapabilities(transport);
    } catch (e) {
      denied = e instanceof RpcError && e.code === "permissionDenied";
    }
    if (!denied) throw new Error("auth gate");
    stage = "authenticate";
    await authenticateWebTransport(transport, fixture.clientId, fixture.secret);
    const caps = await rpc.getDesktopCapabilities(transport);
    if (!operational) return;
    stage = "codec_negotiation";
    const advertised = caps.codecs.filter(
      (item) => item.hardware && /^(hev1|avc[13])\./.test(item.codec),
    );
    const codecs = await supportedDesktopCodecs(advertised);
    if (!codecs.length || !caps.feedback)
      throw new Error("fixture capabilities");
    stage = "attach";
    events = desktopEvents(
      transport,
      {
        profile: 1,
        codecs,
        mediaUniStreams: true,
        keyboardMode: DesktopKeyboardMode.Physical,
      },
      abort.signal,
      ProcId.AttachExistingDesktop,
    );
    const media = {
      incomingUnidirectionalStreams:
        transport.incomingUnidirectionalStreams.pipeThrough(
          new TransformStream({
            transform(stream, streams) {
              counts.tappedStreams++;
              streams.enqueue(
                stream.pipeThrough(
                  new TransformStream({
                    transform(chunk, chunks) {
                      counts.browserTappedMediaBytes += chunk.byteLength;
                      chunks.enqueue(chunk);
                    },
                  }),
                ),
              );
            },
          }),
        ),
    };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    document.body.replaceChildren(canvas);
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) throw new Error("canvas");
    let attachId, control;
    let viewportId;
    while (operational && !configuration) {
      const next = await events.next();
      if (next.done) throw new Error("attach ended");
      const event = next.value;
      if (event.type === "attached") {
        attachId = event.attachId;
        stage = "control";
        control = await rpc.setDesktopControl(transport, {
          attachId,
          action: DesktopControlAction.Acquire,
        });
        if (!operational) return;
        if (control.holderAttachId !== attachId)
          throw new Error("control holder");
        input = new DesktopInputChannel(
          transport,
          attachId,
          () => ({
            inputEpoch: control.inputEpoch,
            layoutEpoch: configuration.layoutEpoch,
          }),
          () => {
            counts.inputFailures++;
            stop("input_channel");
          },
        );
        leaseTimer = setInterval(
          () => {
            void rpc
              .renewDesktopLease(transport, { attachId })
              .catch(() => stop("lease_renewal"));
          },
          Math.max(1000, Math.min(5000, event.leaseMs / 3)),
        );
        receiver = new DesktopVideoReceiver(
          media,
          attachId,
          (id, frame) => {
            if (!operational) return false;
            if (
              id !== viewportId ||
              frame.displayWidth !== width ||
              frame.displayHeight !== height
            ) {
              counts.invalidMarkerDraws++;
              stop("frame_geometry");
              return false;
            }
            context.drawImage(frame, 0, 0, width, height);
            counts.canvasDraws++;
            const marker = readMarker(context);
            if (marker === null) {
              counts.invalidMarkerDraws++;
              stop("invalid_visual_marker");
              return false;
            }
            if (marker > expected) {
              counts.futureMarkerDraws++;
              stop("future_visual_marker");
              return false;
            }
            if (marker < expected) counts.staleMarkerDraws++;
            if (displayed?.id === marker) counts.duplicateMarkerDraws++;
            displayed = { id: marker, timestampMicros: frame.timestamp };
            afterDraw(canvas);
            return true;
          },
          (stats) => {
            if (!operational) return;
            if (stats.requestKeyframe) counts.keyframeRequests++;
            if (stats.objectId !== undefined && expected > fixture.warmup) {
              decodeMicros.push(stats.decodeMicros);
              renderMicros.push(stats.renderMicros);
              counts.maxReceiverQueueDepth = Math.max(
                counts.maxReceiverQueueDepth,
                stats.queueDepth,
              );
            }
            if (input.send({ type: "feedback", ...stats })) {
              counts.feedbackAccepted++;
            } else {
              counts.sendFailures++;
              stop("feedback_not_queued");
            }
          },
          () => {
            counts.receiverFailures++;
            stop("video_receiver");
          },
          () => {
            counts.codecFailures++;
            stop("video_codec");
          },
        );
      } else if (event.type === "configured") {
        stage = "configure";
        const [track] = event.configuration.tracks;
        if (
          !receiver ||
          event.configuration.tracks.length !== 1 ||
          track.viewport.width !== width ||
          track.viewport.height !== height ||
          track.viewport.fps !== 60 ||
          track.viewport.bitrate !== 20_000_000 ||
          track.stripes ||
          track.codec.codec !== codecs[0]
        )
          throw new Error("configuration shape");
        configuration = event.configuration;
        viewportId = track.viewport.viewportId;
        codec = track.codec.codec;
      }
    }
    if (!operational) return;
    // Register initial marker observation before any decoder can render.
    stage = "initial_marker";
    const first = waitForMarker(0, started);
    await receiver.configure(configuration);
    if (!operational) return;
    const initial = await first;
    if (!operational) return;
    firstFrameMs = initial.actionToCanvasRafMs;
    const drainEvents = async () => {
      try {
        for await (const event of events) {
          if (!operational) return;
          if (event.type === "configured" || event.type === "layout") {
            stop("layout_changed");
            return;
          }
        }
        stop("attachment_ended");
      } catch {
        stop("attachment_stream");
      }
    };
    void drainEvents();

    stage = "scroll";
    for (
      let id = 1;
      id <= fixture.warmup + fixture.measured && operational;
      id++
    ) {
      const sample = await waitForMarker(id, performance.now(), () =>
        input.send({
          type: "wheel",
          viewportId,
          x: width / 2,
          y: height / 2,
          dx: 0,
          dy: 12,
          unit: DesktopWheelUnit.Pixels,
        }),
      );
      if (!operational) break;
      results.push(sample);
    }
  }

  try {
    await Promise.race([run().catch(() => stop(`stage_${stage}`)), stopped]);
    const measuredSamples = results.slice(fixture.warmup);
    return {
      scope: "browser_scroll_send_to_canvas_raf",
      clock: "single_browser_performance_now",
      canvasCompletion:
        "two_animation_callbacks_span_a_paint_opportunity_not_scanout",
      mediaByteScope:
        "browser_webtransport_app_stream_tap_includes_possible_abandoned_chunks_not_wire",
      status:
        !failure && measuredSamples.length === fixture.measured
          ? "passed"
          : "failed",
      failure,
      stage,
      execution: receiver?.execution ?? null,
      codec,
      width,
      height,
      fpsTarget: configuration?.tracks[0]?.viewport.fps ?? null,
      bitrateTarget: configuration?.tracks[0]?.viewport.bitrate ?? null,
      canvasReadback: "2d_will_read_frequently_marker_scanline_each_draw",
      markerCountScope:
        "stale_is_below_outstanding_id_not_a_dropped_frame_count",
      observationMs: performance.now() - started,
      coldFirstFrameMs: firstFrameMs,
      warmupActionsExcluded: fixture.warmup,
      completedWarmupActions: Math.min(results.length, fixture.warmup),
      completedMeasuredActions: measuredSamples.length,
      actionToCanvasRafMs: rank(
        measuredSamples.map((sample) => sample.actionToCanvasRafMs),
      ),
      decodeMicrosDuringMeasuredActions: rank(decodeMicros),
      drawAndMarkerCheckMicrosDuringMeasuredActions: rank(renderMicros),
      counts,
      samples: measuredSamples,
    };
  } finally {
    operational = false;
    clearTimeout(deadline);
    clearTimeout(pending?.timer);
    pending?.resolve(null);
    clearInterval(leaseTimer);
    cancelAnimationFrame(raf);
    abort.abort();
    input?.abort();
    receiver?.close();
    transport?.close();
    void events?.return().catch(() => {});
  }
}

let vite, browser;
let stage = "host_guard";
try {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RIEUL_HOSTED_SCREEN_SCROLL !== "1" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.RUNNER_ARCH !== "ARM64" ||
    process.env.GITHUB_REPOSITORY !== "disjukr/rieul.app" ||
    process.env.GITHUB_REF !== "refs/heads/screen-hosted-live-scroll-test" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_WORKFLOW !== "Screen capture capability probe" ||
    process.env.GITHUB_WORKFLOW_REF !==
      "disjukr/rieul.app/.github/workflows/probe-screen-fixture.yml@refs/heads/screen-hosted-live-scroll-test"
  )
    throw new Error("host guard");
  stage = "metadata";
  const { live, url, hash, clientId, secret } = JSON.parse(
    await readFile(process.argv[2], "utf8"),
  );
  if (
    live !== true ||
    !/^https:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/rieul\/rpc$/.test(url) ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    typeof clientId !== "string" ||
    !clientId ||
    typeof secret !== "string" ||
    !secret
  )
    throw new Error("metadata");
  stage = "vite";
  vite = spawn(
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
  let viteExited = false;
  vite.on("error", () => (viteExited = true));
  vite.on("exit", () => (viteExited = true));
  let ready = false;
  for (let i = 0; i < 100 && !viteExited; i++) {
    try {
      ready = (await fetch(origin, { signal: AbortSignal.timeout(500) })).ok;
      if (ready) break;
    } catch {
      // Startup is bounded by this polling loop and the parent test timeout.
    }
    await delay(100);
  }
  if (!ready || viteExited) throw new Error("vite startup");

  stage = "browser_start";
  browser = await chromium.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    timeout: 5000,
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.route(fixturePage, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Rieul hosted Screen fixture</title><body></body>",
    }),
  );
  await page.goto(fixturePage, { timeout: 5000 });
  stage = "browser_evaluate";
  const result = await page.evaluate(observeScroll, {
    url,
    hash,
    clientId,
    secret,
    warmup,
    measured,
    deadlineMs,
  });
  console.log(
    JSON.stringify({
      kind: "hosted_screen_browser",
      browserVersion: browser.version(),
      ...result,
    }),
  );
  if (result.status !== "passed") process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      kind: "hosted_screen_browser",
      status: "failed",
      failure: stage,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } finally {
    if (vite?.pid) {
      try {
        process.kill(-vite.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
  }
}
