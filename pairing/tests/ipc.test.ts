import { test } from "node:test";
import assert from "node:assert/strict";
const expect = (actual: unknown) => ({
  toBe: (expected: unknown) => assert.equal(actual, expected),
  toBeGreaterThan: (expected: number) =>
    assert.ok(typeof actual === "number" && actual > expected),
  toBeUndefined: () => assert.equal(actual, undefined),
});
import net from "node:net";
import { PairingController } from "../src/controller.ts";
import { startIpc, activateExisting } from "../src/ipc.ts";
import {
  encodeActivateGuiReq,
  encodeSocketUnaryRequest,
  IPC_PROC_ACTIVATE_GUI,
  IPC_PROC_CONFIRM_PAIRING,
  encodeSocketUnaryOkResponse,
} from "../../web/src/protocol/socket-ipc.ts";
import { encodeCbor } from "../../web/src/protocol/cbor.ts";
import { endpoint, profileId } from "../src/profile.ts";
test("real node:net pipe fragmented requests, half close, duplicate activation and disposal", async () => {
  let shown = 0;
  const controller = new PairingController(
    {
      configPath: "fixture",
      profileId: "fixture",
      daemonUrl: "https://fixture.invalid",
      daemonVersion: "test",
    },
    {
      show() {
        shown++;
      },
      hide() {},
      title() {},
      async notify() {
        return false;
      },
      async openConfig() {},
    },
  );
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\rieul-pairing-test-${process.pid}-${Date.now()}`
      : `/tmp/rieul-pairing-test-${process.pid}-${Date.now()}.sock`;
  const server = await startIpc(address, controller);
  if (!server) throw new Error("fixture collision");
  try {
    expect(await activateExisting(address)).toBe(true);
    const bytes = encodeSocketUnaryRequest(
      9,
      IPC_PROC_ACTIVATE_GUI,
      encodeActivateGuiReq("fragmented"),
    );
    const response = await new Promise<Buffer>((resolve, reject) => {
      const socket = net.createConnection(address);
      const chunks: Buffer[] = [];
      socket.on("error", reject);
      socket.on("data", (b) => chunks.push(b));
      socket.on("end", () => resolve(Buffer.concat(chunks)));
      socket.on("connect", () => {
        socket.write(bytes.subarray(0, 3));
        setTimeout(() => socket.end(bytes.subarray(3)), 5);
      });
    });
    expect(response.length).toBeGreaterThan(0);
    expect(shown).toBe(2);
    expect(await startIpc(address, controller)).toBeUndefined();
    expect(shown).toBe(3);
    const socket = net.createConnection(address);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      encodeSocketUnaryRequest(
        1,
        IPC_PROC_CONFIRM_PAIRING,
        encodeCbor(
          new Map([
            [1, "https://fixture.invalid"],
            [2, "42"],
            [3, "fixture"],
          ]),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await controller.getSnapshot()).route.kind).toBe("idle");
  } finally {
    await server.dispose();
  }
  expect(await activateExisting(address)).toBe(false);
});
test("activation rejects malformed, wrong-stream and truncated peer replies", async () => {
  const good = encodeSocketUnaryOkResponse(1);
  const replies = [
    new Uint8Array(),
    new Uint8Array([0xff]),
    encodeSocketUnaryOkResponse(2),
    good.subarray(0, good.length - 1),
    Buffer.concat([good, new Uint8Array([0x1a])]),
  ];
  for (let i = 0; i < replies.length; i++) {
    const address = endpoint(
      profileId(`invalid-activation-${process.pid}-${Date.now()}-${i}`),
    );
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end(replies[i]));
    });
    await new Promise<void>((resolve) => server.listen(address, resolve));
    try {
      await assert.rejects(activateExisting(address));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
test("invalid requests leave the pipe usable, disconnected confirmations cannot resolve later, dispose is idempotent", async () => {
  const controller = new PairingController(
    {
      configPath: "fixture",
      profileId: "fixture",
      daemonUrl: "https://fixture.invalid",
      daemonVersion: "test",
    },
    {
      show() {},
      hide() {},
      title() {},
      async notify() {
        return true;
      },
      async openConfig() {},
    },
  );
  const address = endpoint(
    profileId(`invalid-request-${process.pid}-${Date.now()}`),
  );
  const server = await startIpc(address, controller);
  assert.ok(server);
  try {
    for (const bytes of [
      new Uint8Array([0xff]),
      encodeSocketUnaryRequest(1, 999),
      encodeSocketUnaryRequest(1, 2, new Uint8Array([0xff])),
    ]) {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(address);
        socket.on("error", reject);
        socket.on("data", () => {});
        socket.on("close", () => resolve());
        socket.on("connect", () => socket.end(bytes));
      });
      assert.equal((await controller.getSnapshot()).route.kind, "idle");
      assert.equal(await activateExisting(address), true);
    }
    await assert.rejects(controller.resolvePairingConfirmation(true));
  } finally {
    await Promise.all([server.dispose(), server.dispose()]);
  }
  assert.equal(await activateExisting(address), false);
});
test("two real profile pipes keep confirmations and activation independent", async () => {
  const calls = [0, 0];
  const controllers = [0, 1].map(
    (i) =>
      new PairingController(
        {
          configPath: `fixture-${i}`,
          profileId: `fixture-${i}`,
          daemonUrl: "https://fixture.invalid",
          daemonVersion: "test",
        },
        {
          show() {
            calls[i]++;
          },
          hide() {},
          title() {},
          async notify() {
            return true;
          },
          async openConfig() {},
        },
      ),
  );
  const addresses = controllers.map((_, i) =>
    endpoint(profileId(`pairing-isolation-${process.pid}-${Date.now()}-${i}`)),
  );
  const servers = await Promise.all(
    controllers.map((controller, i) => startIpc(addresses[i], controller)),
  );
  try {
    let settled = false;
    const pending = controllers[0]
      .request({
        streamId: 1,
        procId: IPC_PROC_CONFIRM_PAIRING,
        payload: encodeCbor(
          new Map([
            [1, "https://fixture.invalid"],
            [2, "42"],
            [3, "fixture"],
          ]),
        ),
      })
      .then((value) => {
        settled = true;
        return value;
      });
    expect(await activateExisting(addresses[1])).toBe(true);
    expect(calls[0]).toBe(0);
    expect(calls[1]).toBe(1);
    expect(settled).toBe(false);
    await controllers[1].showDaemonInfo();
    expect(settled).toBe(false);
    controllers[0].close();
    await pending;
    expect(settled).toBe(true);
  } finally {
    await Promise.all(servers.map((server) => server?.dispose()));
  }
});
test(
  "incomplete peers time out without timing out a user confirmation",
  { timeout: 10000 },
  async () => {
    const controller = new PairingController(
      {
        configPath: "fixture",
        profileId: "fixture",
        daemonUrl: "https://fixture.invalid",
        daemonVersion: "test",
      },
      {
        show() {},
        hide() {},
        title() {},
        async notify() {
          return true;
        },
        async openConfig() {},
      },
    );
    const address = endpoint(
      profileId(`idle-request-${process.pid}-${Date.now()}`),
    );
    const server = await startIpc(address, controller);
    assert.ok(server);
    const incomplete = net.createConnection(address);
    const confirmation = net.createConnection(address);
    try {
      const ended = new Promise<void>((resolve, reject) => {
        incomplete.on("error", reject);
        incomplete.on("close", () => resolve());
      });
      const response = new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        confirmation.on("error", reject);
        confirmation.on("data", (bytes) => chunks.push(bytes));
        confirmation.on("end", () => resolve(Buffer.concat(chunks)));
        confirmation.on("connect", () =>
          confirmation.write(
            encodeSocketUnaryRequest(
              1,
              2,
              encodeCbor(
                new Map([
                  [1, "https://fixture.invalid"],
                  [2, "42"],
                  [3, "fixture"],
                ]),
              ),
            ),
          ),
        );
      });
      await ended;
      assert.equal(
        (await controller.getSnapshot()).route.kind,
        "confirmPairing",
      );
      await controller.resolvePairingConfirmation(false);
      assert.ok((await response).length > 0);
    } finally {
      incomplete.destroy();
      confirmation.destroy();
      await server.dispose();
    }
  },
);
