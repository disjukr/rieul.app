import { test, expect } from "bun:test";
import { PairingController, type Shell } from "../src/controller.ts";
import { endpoint, profileId } from "../src/profile.ts";
import { encodeCbor } from "../../web/src/protocol/cbor.ts";
import {
  IPC_PROC_CONFIRM_PAIRING,
  IPC_PROC_SHOW_PAIRING_CODE,
  IPC_PROC_PAIRING_COMPLETED,
  IPC_PROC_ACTIVATE_GUI,
  encodeActivateGuiReq,
} from "../../web/src/protocol/socket-ipc.ts";
const info = {
  configPath: "fixture.yaml",
  daemonUrl: "https://fixture.invalid:9012",
  profileId: "fixture",
  daemonVersion: "fixture",
};
function fixture(notify = false) {
  const calls: string[] = [];
  const shell: Shell = {
    show() {
      calls.push("show");
    },
    hide() {
      calls.push("hide");
    },
    title() {},
    async notify() {
      return notify;
    },
    async openConfig() {
      calls.push("openConfig");
    },
  };
  return { controller: new PairingController(info, shell), calls };
}
const confirmation = (code = "42") => ({
  procId: IPC_PROC_CONFIRM_PAIRING,
  streamId: 1,
  payload: encodeCbor(
    new Map([
      [1, info.daemonUrl],
      [2, code],
      [3, "Disposable fixture"],
    ]),
  ),
});
const rejected = encodeCbor(new Map([[1, false]]));
test("replacement, stale click, explicit rejection and snapshot subscriptions", async () => {
  const { controller } = fixture();
  const events: string[] = [];
  const off = controller.subscribe((s) => events.push(s.route.kind));
  const first = controller.request(confirmation());
  const old = controller.generation;
  const second = controller.request(confirmation("73"));
  expect(await first).toEqual(rejected);
  await expect(
    controller.resolvePairingConfirmation(true, old),
  ).rejects.toThrow();
  await controller.resolvePairingConfirmation(false);
  expect(await second).toEqual(rejected);
  off();
  controller.close();
  expect(events).toEqual(["confirmPairing", "confirmPairing"]);
  controller.dispose();
});
test("abort, close, dispose all reject pending requests; close hides and activation reopens", async () => {
  for (const mode of ["abort", "close", "dispose"]) {
    const { controller, calls } = fixture();
    const signal = new AbortController();
    const pending = controller.request(confirmation(), signal.signal);
    if (mode === "abort") signal.abort();
    else if (mode === "close") controller.close();
    else controller.dispose();
    expect(await pending).toEqual(rejected);
    if (mode !== "dispose") {
      expect((await controller.getSnapshot()).route.kind).toBe("idle");
      expect(calls).toContain("hide");
      controller.activate();
      expect(calls.at(-1)).toBe("show");
    }
    controller.dispose();
    controller.dispose();
    await expect(controller.resolvePairingConfirmation(true)).rejects.toThrow();
  }
});
test("notification fallback, four bindings, code completion and unique candidates", async () => {
  const { controller, calls } = fixture();
  const pending = controller.request(confirmation());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toContain("show");
  const route = (await controller.getSnapshot()).route;
  if (route.kind !== "confirmPairing") throw new Error("route");
  expect(new Set(route.model.candidates).size).toBe(4);
  expect(route.model.candidates).toContain("42");
  await controller.showDaemonInfo();
  expect(await pending).toEqual(rejected);
  await controller.openConfig();
  expect(calls).toContain("openConfig");
  await controller.request({
    procId: IPC_PROC_SHOW_PAIRING_CODE,
    streamId: 1,
    payload: encodeCbor(
      new Map<number, string | number>([
        [1, info.daemonUrl],
        [2, "FIXTURE"],
        [3, 30],
      ]),
    ),
  });
  expect((await controller.getSnapshot()).route.kind).toBe("pairingCode");
  await controller.request({ procId: IPC_PROC_PAIRING_COMPLETED, streamId: 1 });
  expect((await controller.getSnapshot()).route.kind).toBe("idle");
  await controller.request({
    procId: IPC_PROC_ACTIVATE_GUI,
    streamId: 1,
    payload: encodeActivateGuiReq("test"),
  });
  expect(calls.at(-1)).toBe("show");
  controller.dispose();
});
test("profile identity matches existing SHA256 path contract and endpoints are isolated", () => {
  expect(profileId("C:\\fixture\\rieul.yaml", "win32")).toBe(
    profileId("\\\\?\\C:\\fixture\\rieul.yaml", "win32"),
  );
  expect(profileId("\\\\server\\fixture.yaml", "win32")).toBe(
    profileId("\\\\?\\UNC\\server\\fixture.yaml", "win32"),
  );
  expect(endpoint(profileId("a"))).not.toBe(endpoint(profileId("b")));
  expect(endpoint("abc", "darwin", 501)).toBe(
    "/tmp/rieul-gui-profile-abc-501.sock",
  );
});
test("notification exception falls back once and stale fallback never reopens replacement", async () => {
  const { controller, calls } = fixture();
  const first = controller.request(confirmation());
  await controller.showDaemonInfo();
  const shows = calls.filter((c) => c === "show").length;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.filter((c) => c === "show").length).toBe(shows);
  expect(await first).toEqual(rejected);
  controller.dispose();
  const failed = new PairingController(info, {
    show() {
      calls.push("fallback");
    },
    hide() {},
    title() {},
    async notify() {
      throw new Error("notification unavailable");
    },
    async openConfig() {},
  });
  const second = failed.request(confirmation());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toContain("fallback");
  failed.dispose();
  expect(await second).toEqual(rejected);
});
test("malformed and unsupported requests cannot mutate a pending confirmation", async () => {
  const { controller } = fixture(true);
  let settled = false;
  const pending = controller.request(confirmation()).then((value) => {
    settled = true;
    return value;
  });
  const generation = controller.generation;
  for (const procId of [1, 2, 3, 4, 999]) {
    await expect(
      controller.request({
        procId,
        streamId: 1,
        payload: new Uint8Array([0xff]),
      }),
    ).rejects.toThrow();
    expect(controller.generation).toBe(generation);
    expect((await controller.getSnapshot()).route.kind).toBe("confirmPairing");
    expect(settled).toBe(false);
  }
  controller.close();
  expect(await pending).toEqual(rejected);
  controller.dispose();
});
